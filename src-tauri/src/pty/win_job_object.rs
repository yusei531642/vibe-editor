//! Issue #950: PTY 子プロセスの OS 寿命バインド (Windows Job Object)。
//!
//! 従来の回収は「正常終了経路での taskkill /T」(#951 で blocking 化) のみで、
//! vibe-editor 本体の **クラッシュ / taskkill 強制終了** では誰も taskkill を呼べず、
//! claude/codex とその配下 (MCP node 等の孫プロセス) が孤児として残っていた。
//!
//! 本 module は `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 付きの Job Object を PTY child
//! ごとに作成して child PID を assign する。Job handle は `SessionHandle` が保持し、
//! - handle drop (タブ close / kill_all) → CloseHandle → job 内全プロセスを OS が kill
//! - vibe-editor 本体の異常死 → OS が全 handle を強制 close → 同様に kill
//!
//! の両経路で「親の寿命 = 子プロセスツリーの寿命」を OS レベルで保証する。
//!
//! 制限:
//! - assign は spawn 後の後付けなので、child が assign 前に spawn した孫は job に
//!   入らない (sub-ms の race、実用上 cmd.exe / node の初期化より十分速い)。
//!   taskkill /T fallback (#951) は引き続き併用する (defense in depth)。
//! - 子が `CREATE_BREAKAWAY_FROM_JOB` を明示しない限り孫は job を継承する
//!   (Windows 8+ の nested job により、子が自前の job を作っても破綻しない)。

#![cfg(windows)]

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

/// KILL_ON_JOB_CLOSE な Job Object の RAII wrapper。
/// drop (= 最後の handle close) で job 内の全プロセスが OS によって kill される。
pub struct KillOnCloseJob(HANDLE);

// HANDLE は kernel object への参照で、所有権ごと thread 間を移動しても安全。
unsafe impl Send for KillOnCloseJob {}
unsafe impl Sync for KillOnCloseJob {}

impl KillOnCloseJob {
    /// Job Object を作成して KILL_ON_JOB_CLOSE を設定する。失敗は warn ログを残して
    /// None (Job 無しでも従来の taskkill 経路は生きているため起動自体は止めない)。
    pub fn create() -> Option<Self> {
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                tracing::warn!(
                    "[pty] CreateJobObjectW failed (err={}); child lifetime binding disabled",
                    GetLastError()
                );
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                tracing::warn!(
                    "[pty] SetInformationJobObject(KILL_ON_JOB_CLOSE) failed (err={})",
                    GetLastError()
                );
                let _ = CloseHandle(job);
                return None;
            }
            Some(Self(job))
        }
    }

    /// `pid` のプロセスをこの job に割り当てる。以降にそのプロセスが spawn する
    /// 子孫は自動的に job へ入る。失敗 (既に終了 / 権限) は warn を残して false。
    pub fn assign_pid(&self, pid: u32) -> bool {
        unsafe {
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process.is_null() {
                tracing::warn!(
                    "[pty] OpenProcess(pid={pid}) for job assignment failed (err={})",
                    GetLastError()
                );
                return false;
            }
            let ok = AssignProcessToJobObject(self.0, process);
            let _ = CloseHandle(process);
            if ok == 0 {
                tracing::warn!(
                    "[pty] AssignProcessToJobObject(pid={pid}) failed (err={})",
                    GetLastError()
                );
                return false;
            }
            tracing::debug!("[pty] child pid={pid} bound to kill-on-close job object");
            true
        }
    }
}

impl Drop for KillOnCloseJob {
    fn drop(&mut self) {
        // KILL_ON_JOB_CLOSE: この close で job 内に残る全プロセスが kill される。
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_and_drop_does_not_panic() {
        // Job Object の作成 + KILL_ON_JOB_CLOSE 設定 + drop (CloseHandle) の往復 smoke。
        let job = KillOnCloseJob::create();
        assert!(job.is_some(), "job object creation should succeed on Windows");
        drop(job);
    }

    #[test]
    fn assigned_child_is_killed_when_job_drops() {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // 長時間生きる無害な child (ping ループ) を spawn → job に assign → job drop で
        // OS により kill されることを実プロセスで検証する。
        let mut child = std::process::Command::new("ping")
            .args(["-n", "60", "127.0.0.1"])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .expect("spawn ping");
        let job = KillOnCloseJob::create().expect("create job");
        assert!(job.assign_pid(child.id()), "assign must succeed for live child");
        drop(job); // KILL_ON_JOB_CLOSE → child が OS に kill される

        // kill 反映を少し待ってから確認 (best-effort、最大 ~2s)
        let mut exited = false;
        for _ in 0..40 {
            if let Ok(Some(_)) = child.try_wait() {
                exited = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        if !exited {
            let _ = child.kill(); // テストの後始末 (失敗時に ping を残さない)
        }
        assert!(exited, "child must be killed by job close");
    }
}

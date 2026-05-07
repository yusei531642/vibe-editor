// PTY セッション本体
//
// 旧 ipc/terminal.ts の `pty.spawn(...)` 部分を移植。
// portable-pty + tokio + tauri::Emitter で同等機能を再現。

use crate::pty::batcher::spawn_batcher;
use crate::pty::scrollback::{
    scrollback_to_string, Scrollback, WriteBudget, MAX_TERMINAL_WRITE_BYTES_PER_CALL,
    MAX_TERMINAL_WRITE_BYTES_PER_SEC, TERMINAL_WRITE_WINDOW,
};
use anyhow::{anyhow, Result};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitInfo {
    pub exit_code: i64,
    pub signal: Option<i32>,
}

#[derive(Clone)]
pub struct SpawnOptions {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub is_codex: bool,
    pub cols: u16,
    pub rows: u16,
    pub env: HashMap<String, String>,
    pub agent_id: Option<String>,
    /// Issue #271: HMR 経路で同じ React mount identity を共有する論理キー。
    /// renderer 側の `TerminalCreateOptions.sessionKey` と一致する。
    pub session_key: Option<String>,
    pub team_id: Option<String>,
    pub role: Option<String>,
}

/// 1 セッションぶんの状態。kill / write / resize 用に master と writer を Mutex 保持。
pub struct SessionHandle {
    /// 旧 Session.pty.write 相当
    writer: Mutex<Box<dyn Write + Send>>,
    /// resize 用に保持
    master: Mutex<Box<dyn MasterPty + Send>>,
    /// kill 用 (子プロセス側 — drop で殺せないことがあるため明示保持)
    killer: Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
    pub agent_id: Option<String>,
    /// Issue #271: HMR 経路で attach 先を引くための論理キー。
    /// `SessionRegistry::by_session_key` の逆引き先になる。
    pub session_key: Option<String>,
    pub team_id: Option<String>,
    pub role: Option<String>,
    pub cwd: String,
    pub is_codex: bool,
    /// Issue #153: prompt injection 中はユーザー入力を抑止する。
    /// `inject_codex_prompt_to_pty` 等が begin/end で立て下げる。
    /// renderer 側からの terminal_write は user_write 経由でこのフラグを見る。
    injecting: std::sync::atomic::AtomicBool,
    /// Issue #214: terminal_write の 1 端末ごとのレート制限。
    write_budget: Mutex<WriteBudget>,
    /// Issue #285 follow-up: attach 経路で renderer に過去出力を replay するための
    /// 直近 64 KiB の出力リングバッファ。`spawn_batcher` の flush で更新される。
    scrollback: Scrollback,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UserWriteOutcome {
    Written,
    SuppressedInjecting,
    DroppedTooLarge,
    DroppedRateLimited,
}

impl SessionHandle {
    /// 内部 / inject 経路用: フラグの状態にかかわらず常に書き込む。
    pub fn write(&self, data: &[u8]) -> Result<()> {
        let mut w = self
            .writer
            .lock()
            .map_err(|e| anyhow!("writer lock poisoned: {e}"))?;
        w.write_all(data)?;
        w.flush()?;
        Ok(())
    }

    /// Issue #153 / #214:
    /// - inject 中は drop
    /// - 1 回の payload は 64 KiB 上限
    /// - 1 秒あたり 256 KiB を超える入力は drop
    pub fn user_write(&self, data: &[u8]) -> Result<UserWriteOutcome> {
        if self.injecting.load(std::sync::atomic::Ordering::Acquire) {
            return Ok(UserWriteOutcome::SuppressedInjecting);
        }
        if data.len() > MAX_TERMINAL_WRITE_BYTES_PER_CALL {
            return Ok(UserWriteOutcome::DroppedTooLarge);
        }
        {
            let mut budget = self
                .write_budget
                .lock()
                .map_err(|e| anyhow!("write_budget lock poisoned: {e}"))?;
            let now = Instant::now();
            if now.duration_since(budget.window_started_at) >= TERMINAL_WRITE_WINDOW {
                budget.window_started_at = now;
                budget.bytes_in_window = 0;
            }
            if budget.bytes_in_window.saturating_add(data.len()) > MAX_TERMINAL_WRITE_BYTES_PER_SEC
            {
                return Ok(UserWriteOutcome::DroppedRateLimited);
            }
            budget.bytes_in_window += data.len();
        }
        self.write(data)?;
        Ok(UserWriteOutcome::Written)
    }

    pub fn set_injecting(&self, on: bool) {
        self.injecting
            .store(on, std::sync::atomic::Ordering::Release);
    }

    /// Issue #285 follow-up: attach 経路で renderer へ replay する用の現時点 snapshot。
    /// 末尾が multi-byte 文字途中なら切り詰め、UTF-8 安全な文字列に変換する。
    /// 空の場合は None を返す (renderer 側は空文字を区別しない用に短絡できる)。
    pub fn scrollback_snapshot(&self) -> Option<String> {
        scrollback_to_string(&self.scrollback)
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        let m = self
            .master
            .lock()
            .map_err(|e| anyhow!("master lock poisoned: {e}"))?;
        m.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    pub fn kill(&self) -> Result<()> {
        let mut k = self
            .killer
            .lock()
            .map_err(|e| anyhow!("killer lock poisoned: {e}"))?;
        let _ = k.kill();
        Ok(())
    }

    pub fn cleanup_codex_broker_if_stale(&self) {
        if self.is_codex {
            crate::pty::codex_broker::cleanup_stale_for_cwd(&self.cwd);
        }
    }

    pub fn cleanup_codex_broker_after_kill(&self) {
        if !self.is_codex {
            return;
        }
        let summary = crate::pty::codex_broker::cleanup_stale_for_cwd(&self.cwd);
        if summary.skipped_live > 0 {
            std::thread::sleep(Duration::from_millis(250));
            crate::pty::codex_broker::cleanup_stale_for_cwd(&self.cwd);
        }
    }
}

/// Issue #144: SessionHandle が drop されたタイミングで child プロセスを必ず kill する。
/// SessionRegistry::remove() は kill を呼ばずに Map から外すだけだったため、
/// Arc の参照が残っている間 reader thread が PTY master を保持し続け、
/// 子プロセス + reader thread が孤立リークしていた。
///
/// drop でも kill を呼ぶことで「registry から外す = reader が EOF を読む = thread 終了」
/// が確実に成立する。kill 時の Mutex poison はこの段階では recovery 不能なので無視 (best-effort)。
impl Drop for SessionHandle {
    fn drop(&mut self) {
        if let Ok(mut k) = self.killer.lock() {
            let _ = k.kill();
        }
    }
}

/// `cwd` の検証 (旧 resolveValidCwd と同等)。
/// 無効なら fallback → カレントディレクトリ。warning メッセージも返す。
pub fn resolve_valid_cwd(requested: &str, fallback: Option<&str>) -> (String, Option<String>) {
    let is_dir = |p: &str| !p.is_empty() && Path::new(p).is_dir();
    if is_dir(requested) {
        return (requested.to_string(), None);
    }
    if let Some(fb) = fallback {
        if is_dir(fb) {
            return (
                fb.to_string(),
                Some(format!(
                    "指定された作業ディレクトリが無効です: {} → {} で起動します",
                    if requested.is_empty() {
                        "(未設定)"
                    } else {
                        requested
                    },
                    fb
                )),
            );
        }
    }
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| ".".to_string());
    (
        cwd.clone(),
        Some(format!(
            "作業ディレクトリが無効です: {} → プロセス既定の {} で起動します",
            if requested.is_empty() {
                "(未設定)"
            } else {
                requested
            },
            cwd
        )),
    )
}

/// Issue #211:
/// 親プロセス env を denylist ではなく allowlist で継承する。
/// TeamHub 用の内部 env は `opts.env` から明示注入されたものだけが後段で渡る。
fn should_inherit_env(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    if upper.starts_with("LC_") || upper.starts_with("XDG_") {
        return true;
    }
    matches!(
        upper.as_str(),
        "PATH"
            | "PATHEXT"
            | "HOME"
            | "PWD"
            | "USER"
            | "USERNAME"
            | "LOGNAME"
            | "LANG"
            | "TERM"
            | "COLORTERM"
            | "SHELL"
            | "TMP"
            | "TEMP"
            | "TMPDIR"
            | "TZ"
            | "SYSTEMROOT"
            | "WINDIR"
            | "COMSPEC"
            | "APPDATA"
            | "LOCALAPPDATA"
            | "PROGRAMDATA"
            | "PROGRAMFILES"
            | "PROGRAMFILES(X86)"
            | "COMMONPROGRAMFILES"
            | "COMMONPROGRAMFILES(X86)"
            | "USERPROFILE"
            | "HOMEDRIVE"
            | "HOMEPATH"
            | "OS"
            | "NUMBER_OF_PROCESSORS"
            | "PROCESSOR_ARCHITECTURE"
            | "PROCESSOR_IDENTIFIER"
            | "WT_SESSION"
            | "WT_PROFILE_ID"
            | "MSYSTEM"
            | "WSLENV"
            | "WSL_DISTRO_NAME"
    )
}

#[cfg(test)]
mod env_strip_tests {
    use super::should_inherit_env;

    #[test]
    fn blocks_internal_team_env_from_parent_process() {
        assert!(!should_inherit_env("VIBE_TEAM_SOCKET"));
        assert!(!should_inherit_env("VIBE_TEAM_TOKEN"));
        assert!(!should_inherit_env("VIBE_AGENT_ID"));
    }

    #[test]
    fn blocks_common_secrets_by_default() {
        assert!(!should_inherit_env("AWS_SECRET_ACCESS_KEY"));
        assert!(!should_inherit_env("GITHUB_TOKEN"));
        assert!(!should_inherit_env("OPENAI_API_KEY"));
        assert!(!should_inherit_env("ANTHROPIC_API_KEY"));
        assert!(!should_inherit_env("DATABASE_URL"));
        assert!(!should_inherit_env("DOCKER_AUTH_CONFIG"));
        assert!(!should_inherit_env("SSH_AUTH_SOCK"));
    }

    #[test]
    fn keeps_ordinary_env() {
        assert!(should_inherit_env("PATH"));
        assert!(should_inherit_env("HOME"));
        assert!(should_inherit_env("LANG"));
        assert!(should_inherit_env("USER"));
        assert!(should_inherit_env("TERM"));
        assert!(should_inherit_env("LC_ALL"));
        assert!(should_inherit_env("XDG_RUNTIME_DIR"));
    }
}

pub fn spawn_session(
    app: AppHandle,
    id: String,
    opts: SpawnOptions,
    registry: std::sync::Arc<crate::pty::SessionRegistry>,
) -> Result<SessionHandle> {
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: opts.rows.max(5),
        cols: opts.cols.max(20),
        pixel_width: 0,
        pixel_height: 0,
    })?;

    // Windows: PATHEXT 経由で .cmd / .bat / .exe を解決する。
    // 旧 node-pty は内部で同等処理をしていたため、claude → claude.cmd の自動解決が必要。
    let resolved_command = which::which(&opts.command)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| opts.command.clone());
    let mut cmd = CommandBuilder::new(&resolved_command);
    for a in &opts.args {
        cmd.arg(a);
    }
    cmd.cwd(&opts.cwd);
    for (k, v) in std::env::vars() {
        if !should_inherit_env(&k) {
            continue;
        }
        cmd.env(k, v);
    }
    for (k, v) in &opts.env {
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let mut child = pair.slave.spawn_command(cmd)?;
    drop(pair.slave);

    let killer = child.clone_killer();

    // reader thread (blocking IO -> mpsc)
    let mut reader = pair.master.try_clone_reader()?;
    let writer = pair.master.take_writer()?;

    let data_event = format!("terminal:data:{id}");
    let exit_event = format!("terminal:exit:{id}");

    // Issue #53: bounded channel で reader → batcher に backpressure をかける。
    //   reader (std::thread) は `blocking_send` でチャネル満杯時に待機 → OS 側で PTY
    //   への入力が詰まれば子プロセスが書き込み待ちに入るので、メモリ無限膨張を防げる。
    //
    // チャンクサイズは 16 KiB。旧 8 KiB 比で大量出力時 (cargo build 等) の syscall /
    // Vec allocation / channel send 頻度が約半分になる。read() は OS が用意した
    // 即時バイト数を返すブロッキング読み出しなので、対話的な小入力では従来通り少バイト
    // しか allocate されない (latency 影響なし)。最大 backpressure は
    // 16 KiB * PTY_CHANNEL_CAPACITY ≒ 4 MiB。
    let (tx, rx) = mpsc::channel::<Vec<u8>>(crate::pty::batcher::PTY_CHANNEL_CAPACITY);
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    // blocking_send: async runtime 外でも動く tokio API
                    if tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Issue #285 follow-up: scrollback リングバッファ。batcher と SessionHandle で共有。
    let scrollback = crate::pty::scrollback::new_scrollback();

    spawn_batcher(app.clone(), data_event, rx, scrollback.clone());

    // exit watcher (blocking child.wait → emit exit event)
    // Issue #152: child.wait() の後に registry からも remove して、孤立 entry が
    // residual に残らないようにする (renderer が落ちて terminal_kill が呼ばれない経路で必要)。
    let app_for_exit = app.clone();
    let exit_event_clone = exit_event.clone();
    let registry_for_exit = registry.clone();
    let id_for_exit = id.clone();
    std::thread::spawn(move || {
        let exit_status = child.wait().ok();
        let info = TerminalExitInfo {
            exit_code: exit_status
                .as_ref()
                .map(|s| s.exit_code() as i64)
                .unwrap_or(-1),
            signal: None,
        };
        if let Err(e) = app_for_exit.emit(&exit_event_clone, info) {
            tracing::warn!("emit {exit_event_clone} failed: {e}");
        }
        // child.wait() が返った時点で kill 不要だが、registry::remove は handle.kill() を呼ぶ。
        // SessionHandle::kill() は何度呼んでも安全 (ChildKiller 内部で no-op)。
        let _ = registry_for_exit.remove(&id_for_exit);
    });

    Ok(SessionHandle {
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
        killer: Mutex::new(killer),
        agent_id: opts.agent_id,
        session_key: opts.session_key,
        team_id: opts.team_id,
        role: opts.role,
        cwd: opts.cwd,
        is_codex: opts.is_codex,
        injecting: std::sync::atomic::AtomicBool::new(false),
        write_budget: Mutex::new(WriteBudget {
            window_started_at: std::time::Instant::now(),
            bytes_in_window: 0,
        }),
        scrollback,
    })
}

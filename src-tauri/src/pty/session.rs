// PTY セッション本体
//
// 旧 ipc/terminal.ts の `pty.spawn(...)` 部分を移植。
// portable-pty + tokio + tauri::Emitter で同等機能を再現。

use crate::pty::batcher::spawn_batcher;
use anyhow::{anyhow, Result};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitInfo {
    pub exit_code: i64,
    pub signal: Option<i32>,
}

pub struct SpawnOptions {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub env: HashMap<String, String>,
    pub agent_id: Option<String>,
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
    pub team_id: Option<String>,
    pub role: Option<String>,
}

impl SessionHandle {
    pub fn write(&self, data: &[u8]) -> Result<()> {
        let mut w = self
            .writer
            .lock()
            .map_err(|e| anyhow!("writer lock poisoned: {e}"))?;
        w.write_all(data)?;
        w.flush()?;
        Ok(())
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
}

/// `cwd` の検証 (旧 resolveValidCwd と同等)。
/// 無効なら fallback → カレントディレクトリ。warning メッセージも返す。
pub fn resolve_valid_cwd(
    requested: &str,
    fallback: Option<&str>,
) -> (String, Option<String>) {
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
                    if requested.is_empty() { "(未設定)" } else { requested },
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
            if requested.is_empty() { "(未設定)" } else { requested },
            cwd
        )),
    )
}

/// PTY を 1 つ生成、reader thread を起動、batcher を回し、exit watcher も spawn。
/// 戻り値の SessionHandle は SessionRegistry に登録される。
pub fn spawn_session(
    app: AppHandle,
    id: String,
    opts: SpawnOptions,
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
    // 既存 env を継承しつつ上書き、最低限の TERM/COLORTERM を設定。
    for (k, v) in std::env::vars() {
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

    let (tx, rx) = mpsc::unbounded_channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    spawn_batcher(app.clone(), data_event, rx);

    // exit watcher (blocking child.wait → emit exit event)
    let app_for_exit = app.clone();
    let exit_event_clone = exit_event.clone();
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
    });

    Ok(SessionHandle {
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
        killer: Mutex::new(killer),
        agent_id: opts.agent_id,
        team_id: opts.team_id,
        role: opts.role,
    })
}

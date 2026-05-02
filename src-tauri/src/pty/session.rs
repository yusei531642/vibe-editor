// PTY セッション本体
//
// 旧 ipc/terminal.ts の `pty.spawn(...)` 部分を移植。
// portable-pty + tokio + tauri::Emitter で同等機能を再現。

use crate::pty::batcher::{safe_utf8_boundary, spawn_batcher};
use anyhow::{anyhow, Result};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

/// Issue #285 follow-up: attach 経路 (HMR remount) で「既存 PTY の過去出力」を
/// 新しい xterm に replay するための ring buffer 容量上限。
/// Claude / Codex CLI の banner + 数行の prompt が収まる目安として 64 KiB。
/// これ以上はメモリ膨張の懸念があるので前から drop する。
pub const SCROLLBACK_CAPACITY: usize = 64 * 1024;

/// Issue #285 follow-up: attach 経路で renderer に replay するためのリングバッファ。
/// `spawn_batcher` の flush 時に emit と並行して push し、`scrollback_snapshot()` で
/// UTF-8 安全な文字列として取り出す。
pub type Scrollback = Arc<Mutex<VecDeque<u8>>>;

/// Issue #285 follow-up: scrollback に bytes を push し、上限超過分は前から drop する。
/// `spawn_batcher` から flush ごとに呼ばれる。
pub fn append_scrollback(scrollback: &Scrollback, bytes: &[u8]) {
    let mut guard = match scrollback.lock() {
        Ok(g) => g,
        Err(poisoned) => {
            tracing::warn!("[scrollback] mutex poisoned — recovering");
            poisoned.into_inner()
        }
    };
    guard.extend(bytes);
    let overflow = guard.len().saturating_sub(SCROLLBACK_CAPACITY);
    if overflow > 0 {
        guard.drain(..overflow);
    }
}

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

#[derive(Debug)]
struct WriteBudget {
    window_started_at: Instant,
    bytes_in_window: usize,
}

const MAX_TERMINAL_WRITE_BYTES_PER_CALL: usize = 64 * 1024;
const MAX_TERMINAL_WRITE_BYTES_PER_SEC: usize = 256 * 1024;
const TERMINAL_WRITE_WINDOW: Duration = Duration::from_secs(1);

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
        let guard = match self.scrollback.lock() {
            Ok(g) => g,
            Err(poisoned) => {
                tracing::warn!("[scrollback] snapshot mutex poisoned — recovering");
                poisoned.into_inner()
            }
        };
        if guard.is_empty() {
            return None;
        }
        // VecDeque は連続バイト列ではないので一旦 Vec にコピーする。
        // 上限 64 KiB なので allocation コストは無視できる。
        let bytes: Vec<u8> = guard.iter().copied().collect();
        drop(guard);
        // Codex Lane 4 NIT: 容量超過で前から drain した直後は先頭が UTF-8 continuation バイト
        // (0b10xxxxxx) で始まるケースがある。`String::from_utf8_lossy` は U+FFFD に置換するが、
        // それが画面先頭にゴミとして見えるので、先頭の continuation を skip して文字境界に揃える。
        // 末尾は `safe_utf8_boundary` で従来通り保護する (batcher.rs と共有)。
        let mut start = 0usize;
        while start < bytes.len() && (bytes[start] & 0b1100_0000) == 0b1000_0000 {
            start += 1;
        }
        if start >= bytes.len() {
            return None;
        }
        let safe_end = safe_utf8_boundary(&bytes[start..]) + start;
        if safe_end <= start {
            return None;
        }
        let text = String::from_utf8_lossy(&bytes[start..safe_end]).into_owned();
        if text.is_empty() {
            None
        } else {
            Some(text)
        }
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
mod scrollback_tests {
    //! Issue #285 follow-up: scrollback ring buffer の挙動を検証する。
    //! `append_scrollback` の容量上限・前から drop・UTF-8 境界保護を担保する。
    use super::*;

    fn make_scrollback() -> Scrollback {
        Arc::new(Mutex::new(VecDeque::with_capacity(SCROLLBACK_CAPACITY)))
    }

    fn snapshot_to_string(scrollback: &Scrollback) -> Option<String> {
        // 本番の `SessionHandle::scrollback_snapshot` と同じロジックを test helper として再現。
        // 先頭 continuation バイト skip + 末尾 safe_utf8_boundary を担保する。
        let guard = scrollback.lock().unwrap();
        if guard.is_empty() {
            return None;
        }
        let bytes: Vec<u8> = guard.iter().copied().collect();
        let mut start = 0usize;
        while start < bytes.len() && (bytes[start] & 0b1100_0000) == 0b1000_0000 {
            start += 1;
        }
        if start >= bytes.len() {
            return None;
        }
        let safe_end = safe_utf8_boundary(&bytes[start..]) + start;
        if safe_end <= start {
            return None;
        }
        Some(String::from_utf8_lossy(&bytes[start..safe_end]).into_owned())
    }

    #[test]
    fn empty_scrollback_returns_none() {
        let sb = make_scrollback();
        assert!(snapshot_to_string(&sb).is_none());
    }

    #[test]
    fn append_keeps_short_payload_intact() {
        let sb = make_scrollback();
        append_scrollback(&sb, b"hello world");
        assert_eq!(snapshot_to_string(&sb).as_deref(), Some("hello world"));
    }

    #[test]
    fn append_keeps_japanese_intact() {
        let sb = make_scrollback();
        append_scrollback(&sb, "こんにちは🍣".as_bytes());
        assert_eq!(snapshot_to_string(&sb).as_deref(), Some("こんにちは🍣"));
    }

    #[test]
    fn append_drops_oldest_bytes_when_over_capacity() {
        let sb = make_scrollback();
        // 容量ぴったり ASCII で満たしたあと、追加で 100 バイト書く
        let payload_a: Vec<u8> = vec![b'A'; SCROLLBACK_CAPACITY];
        append_scrollback(&sb, &payload_a);
        let extra: Vec<u8> = vec![b'B'; 100];
        append_scrollback(&sb, &extra);

        let snap = snapshot_to_string(&sb).unwrap();
        // 全長は capacity 以下を維持
        assert!(snap.len() <= SCROLLBACK_CAPACITY);
        // 末尾は 'B' で終わる (新しい方が残る)
        assert!(snap.ends_with("BBBBBBBBBB"));
        // 先頭は古い 'A' が drop されているはず (新しい 'B' が末尾 100 バイト分入っている)
        assert!(snap.starts_with('A'));
    }

    #[test]
    fn append_handles_partial_multibyte_at_tail() {
        let sb = make_scrollback();
        // "あ" = E3 81 82。3 バイトのうち 2 バイトだけ append すると snapshot は
        // 直前の確定文字までしか返さない。
        append_scrollback(&sb, b"hi");
        append_scrollback(&sb, &[0xE3, 0x81]);
        // safe_utf8_boundary が末尾 2 バイトを切り捨てる
        assert_eq!(snapshot_to_string(&sb).as_deref(), Some("hi"));
        // 残り 1 バイトを追加すると "あ" として正しく取り出せる
        append_scrollback(&sb, &[0x82]);
        assert_eq!(snapshot_to_string(&sb).as_deref(), Some("hiあ"));
    }

    #[test]
    fn safe_utf8_boundary_at_complete_char_returns_full_length() {
        let bytes = "abcあ".as_bytes();
        assert_eq!(safe_utf8_boundary(bytes), bytes.len());
    }

    #[test]
    fn safe_utf8_boundary_truncates_middle_of_multibyte() {
        // "abc" + 0xE3 (3 バイト文字の先頭だけ) → 3 バイト目で切る
        let bytes = vec![b'a', b'b', b'c', 0xE3];
        assert_eq!(safe_utf8_boundary(&bytes), 3);
    }

    #[test]
    fn snapshot_skips_leading_continuation_bytes() {
        // Codex Lane 4 NIT: 容量超過 drain 後に先頭が UTF-8 continuation で始まる場合、
        // snapshot は continuation を skip して次の有効な先頭バイトから返す。
        let sb = make_scrollback();
        // "あ" の途中バイト (0x81 0x82) で始まり、続けて完結した "BC" を入れる。
        append_scrollback(&sb, &[0x81, 0x82]);
        append_scrollback(&sb, b"BC");
        // 先頭 2 バイト (continuation) を skip、"BC" だけが取り出される。
        assert_eq!(snapshot_to_string(&sb).as_deref(), Some("BC"));
    }

    #[test]
    fn snapshot_returns_none_when_only_continuation_bytes() {
        let sb = make_scrollback();
        append_scrollback(&sb, &[0x80, 0x81, 0x82, 0x83]);
        // 全部 continuation なので skip すると空 → None
        assert!(snapshot_to_string(&sb).is_none());
    }

    #[test]
    fn snapshot_handles_drain_with_partial_leading_multibyte() {
        // 容量上限ギリギリで multi-byte が drain で切れた状況を模擬。
        let sb = make_scrollback();
        // capacity いっぱいの ASCII を入れる
        let payload: Vec<u8> = vec![b'X'; SCROLLBACK_CAPACITY];
        append_scrollback(&sb, &payload);
        // 続けて "あ" (E3 81 82) を入れると最初の X が 3 つ drop される。
        append_scrollback(&sb, "あ".as_bytes());
        // snapshot は X.....あ で終わる正規 UTF-8 列を返す
        let snap = snapshot_to_string(&sb).unwrap();
        assert!(snap.ends_with('あ'));
        assert!(snap.starts_with('X'));
    }
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
    let (tx, rx) = mpsc::channel::<Vec<u8>>(crate::pty::batcher::PTY_CHANNEL_CAPACITY);
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
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
    let scrollback: Scrollback = Arc::new(Mutex::new(VecDeque::with_capacity(SCROLLBACK_CAPACITY)));

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
            window_started_at: Instant::now(),
            bytes_in_window: 0,
        }),
        scrollback,
    })
}

// PTY セッション本体
//
// 旧 ipc/terminal.ts の `pty.spawn(...)` 部分を移植。
// portable-pty + tokio + tauri::Emitter で同等機能を再現。

use crate::pty::batcher::{spawn_batcher, PtyOutputObserver};
use crate::pty::scrollback::{
    scrollback_to_string, Scrollback, WriteBudget, MAX_TERMINAL_WRITE_BYTES_PER_CALL,
    MAX_TERMINAL_WRITE_BYTES_PER_SEC, TERMINAL_WRITE_WINDOW,
};
use crate::{commands::terminal::command_validation, util::log_redact::redact_home};
use anyhow::{anyhow, Result};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
#[cfg(windows)]
use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::Path;
#[cfg(windows)]
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
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

#[derive(Debug, Clone)]
struct PreparedSpawnCommand {
    requested_command: String,
    resolved_command: String,
    program: String,
    args: Vec<String>,
    path_entries: usize,
    pathext_present: bool,
}

fn prepare_spawn_command(opts: &SpawnOptions) -> Result<PreparedSpawnCommand> {
    let (command, args) = command_validation::normalize_terminal_command(
        Some(opts.command.clone()),
        Some(opts.args.clone()),
    );
    if !command_validation::is_allowed_terminal_command(&command) {
        return Err(anyhow!(
            "command is not allowed at spawn boundary: {command}"
        ));
    }
    if let Some(reason) = command_validation::reject_immediate_exec_args(&command, &args) {
        return Err(anyhow!("{reason}"));
    }
    resolve_spawn_command(&command, args, &opts.env)
}

fn env_value(env: &HashMap<String, String>, key: &str) -> Option<String> {
    env.iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(key))
        .map(|(_, v)| v.clone())
        .or_else(|| std::env::var(key).ok())
        .filter(|v| !v.trim().is_empty())
}

#[cfg(not(windows))]
fn count_path_entries(path: Option<&str>) -> usize {
    path.map(std::env::split_paths)
        .map(|paths| paths.count())
        .unwrap_or(0)
}

#[cfg(not(windows))]
fn resolve_spawn_command(
    command: &str,
    args: Vec<String>,
    env: &HashMap<String, String>,
) -> Result<PreparedSpawnCommand> {
    let resolved_command = which::which(command)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| command.to_string());
    Ok(PreparedSpawnCommand {
        requested_command: command.to_string(),
        resolved_command: resolved_command.clone(),
        program: resolved_command,
        args,
        path_entries: count_path_entries(env_value(env, "PATH").as_deref()),
        pathext_present: false,
    })
}

#[cfg(windows)]
fn resolve_spawn_command(
    command: &str,
    args: Vec<String>,
    env: &HashMap<String, String>,
) -> Result<PreparedSpawnCommand> {
    resolve_windows_spawn_command(command, args, env)
}

#[cfg(windows)]
fn resolve_windows_spawn_command(
    command: &str,
    args: Vec<String>,
    env: &HashMap<String, String>,
) -> Result<PreparedSpawnCommand> {
    let pathext_raw = env_value(env, "PATHEXT");
    let pathext = windows_pathext(pathext_raw.as_deref());
    let search_dirs = windows_search_dirs(env);
    let resolved = resolve_windows_command_path(command, &search_dirs, &pathext)?;
    let mut spawn_args = args;
    let program = if is_windows_cmd_script(&resolved) {
        let mut wrapped = Vec::with_capacity(spawn_args.len() + 2);
        wrapped.push("/C".to_string());
        wrapped.push(resolved.to_string_lossy().into_owned());
        wrapped.append(&mut spawn_args);
        spawn_args = wrapped;
        env_value(env, "COMSPEC").unwrap_or_else(|| "cmd.exe".to_string())
    } else {
        resolved.to_string_lossy().into_owned()
    };

    Ok(PreparedSpawnCommand {
        requested_command: command.to_string(),
        resolved_command: resolved.to_string_lossy().into_owned(),
        program,
        args: spawn_args,
        path_entries: search_dirs.len(),
        pathext_present: pathext_raw.is_some(),
    })
}

#[cfg(windows)]
fn windows_pathext(raw: Option<&str>) -> Vec<String> {
    let values = raw
        .map(|s| {
            s.split(';')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| {
                    let ext = if s.starts_with('.') {
                        s.to_string()
                    } else {
                        format!(".{s}")
                    };
                    ext.to_ascii_lowercase()
                })
                .collect::<Vec<_>>()
        })
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| {
            [".com", ".exe", ".bat", ".cmd"]
                .iter()
                .map(|s| s.to_string())
                .collect()
        });

    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for ext in values {
        if seen.insert(ext.clone()) {
            out.push(ext);
        }
    }
    out
}

#[cfg(windows)]
fn windows_search_dirs(env: &HashMap<String, String>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut seen = HashSet::new();
    let mut push_dir = |path: PathBuf| {
        let key = path.to_string_lossy().to_ascii_lowercase();
        if !key.trim().is_empty() && seen.insert(key) {
            dirs.push(path);
        }
    };

    if let Some(path) = env.iter().find(|(k, _)| k.eq_ignore_ascii_case("PATH")) {
        for dir in std::env::split_paths(path.1) {
            push_dir(dir);
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            push_dir(dir);
        }
    }

    if let Some(appdata) = env_value(env, "APPDATA") {
        push_dir(PathBuf::from(appdata).join("npm"));
    }
    if let Some(userprofile) = env_value(env, "USERPROFILE") {
        push_dir(PathBuf::from(userprofile).join(".local").join("bin"));
    }
    if let Some(localappdata) = env_value(env, "LOCALAPPDATA") {
        let base = PathBuf::from(localappdata);
        push_dir(base.join("Microsoft").join("WindowsApps"));
        push_dir(base.join("OpenAI").join("Codex").join("bin"));
    }

    dirs
}

#[cfg(windows)]
fn command_has_path_separator(command: &str) -> bool {
    command.contains('\\') || command.contains('/')
}

#[cfg(windows)]
fn command_has_extension(command: &str) -> bool {
    Path::new(command).extension().is_some()
}

#[cfg(windows)]
fn candidate_paths(base: &Path, pathext: &[String]) -> Vec<PathBuf> {
    if base.extension().is_some() {
        return vec![base.to_path_buf()];
    }
    let mut out = vec![base.to_path_buf()];
    for ext in pathext {
        out.push(PathBuf::from(format!("{}{}", base.to_string_lossy(), ext)));
    }
    out
}

#[cfg(windows)]
fn resolve_windows_command_path(
    command: &str,
    search_dirs: &[PathBuf],
    pathext: &[String],
) -> Result<PathBuf> {
    let direct_path = PathBuf::from(command);
    if direct_path.is_absolute() || command_has_path_separator(command) {
        for candidate in candidate_paths(&direct_path, pathext) {
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
        return Err(anyhow!(
            "command executable was not found: {}",
            redact_home(command)
        ));
    }

    if command_has_extension(command) {
        if let Ok(found) = which::which(command) {
            return Ok(found);
        }
    } else if let Ok(found) = which::which(command) {
        return Ok(found);
    }

    for dir in search_dirs {
        for candidate in candidate_paths(&dir.join(command), pathext) {
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    Err(anyhow!(
        "command executable was not found: {} (searched {} PATH entries)",
        command,
        search_dirs.len()
    ))
}

#[cfg(windows)]
fn is_windows_cmd_script(path: &Path) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
        .unwrap_or(false)
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

#[cfg(all(test, windows))]
mod spawn_command_resolution_tests {
    use super::*;

    fn base_spawn_options(command: String, args: Vec<String>) -> SpawnOptions {
        SpawnOptions {
            command,
            args,
            cwd: ".".to_string(),
            is_codex: false,
            cols: 80,
            rows: 24,
            env: HashMap::new(),
            agent_id: None,
            session_key: None,
            team_id: None,
            role: None,
        }
    }

    #[test]
    fn resolves_cmd_from_opts_env_path_and_wraps_with_cmd_exe() {
        let tmp = tempfile::tempdir().unwrap();
        let cli = tmp.path().join("fakeagent.cmd");
        std::fs::write(&cli, "@echo off\r\n").unwrap();
        let mut env = HashMap::new();
        env.insert(
            "PATH".to_string(),
            tmp.path().to_string_lossy().into_owned(),
        );

        let prepared =
            resolve_windows_spawn_command("fakeagent", vec!["--version".to_string()], &env)
                .unwrap();

        assert_eq!(
            Path::new(&prepared.program)
                .file_name()
                .and_then(|s| s.to_str())
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("cmd.exe")
        );
        assert_eq!(prepared.args[0], "/C");
        assert_eq!(PathBuf::from(&prepared.args[1]), cli);
        assert_eq!(prepared.args[2], "--version");
        assert_eq!(PathBuf::from(prepared.resolved_command), cli);
    }

    #[test]
    fn resolves_exe_without_cmd_wrapper() {
        let tmp = tempfile::tempdir().unwrap();
        let cli = tmp.path().join("fakeagent.exe");
        std::fs::write(&cli, "").unwrap();
        let mut env = HashMap::new();
        env.insert(
            "PATH".to_string(),
            tmp.path().to_string_lossy().into_owned(),
        );

        let prepared =
            resolve_windows_spawn_command("fakeagent", vec!["--help".to_string()], &env).unwrap();

        assert_eq!(PathBuf::from(&prepared.program), cli);
        assert_eq!(prepared.args, vec!["--help"]);
    }

    #[test]
    fn normalizes_inline_command_again_at_spawn_boundary() {
        let tmp = tempfile::tempdir().unwrap();
        let cli = tmp.path().join("codex.exe");
        std::fs::write(&cli, "").unwrap();
        let command = format!(
            r#""{}" --dangerously-bypass-approvals-and-sandbox"#,
            cli.display()
        );
        let mut opts = base_spawn_options(
            command,
            vec![
                "--config".to_string(),
                "disable_paste_burst=true".to_string(),
            ],
        );

        let prepared = prepare_spawn_command(&opts).unwrap();

        assert_eq!(PathBuf::from(&prepared.program), cli);
        assert_eq!(
            prepared.args,
            vec![
                "--dangerously-bypass-approvals-and-sandbox",
                "--config",
                "disable_paste_burst=true",
            ]
        );

        opts.command = "cmd /c echo unsafe".to_string();
        opts.args.clear();
        let err = prepare_spawn_command(&opts).unwrap_err().to_string();
        assert!(err.contains("cmd immediate-exec flags"));
    }
}

pub fn spawn_session(
    app: AppHandle,
    id: String,
    opts: SpawnOptions,
    registry: std::sync::Arc<crate::pty::SessionRegistry>,
) -> Result<SessionHandle> {
    let prepared_command = prepare_spawn_command(&opts)?;
    tracing::info!(
        "[pty] spawn command requested={} resolved={} launcher={} args.len={} path_entries={} pathext_present={}",
        redact_home(&prepared_command.requested_command),
        redact_home(&prepared_command.resolved_command),
        redact_home(&prepared_command.program),
        prepared_command.args.len(),
        prepared_command.path_entries,
        prepared_command.pathext_present
    );

    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: opts.rows.max(5),
        cols: opts.cols.max(20),
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let mut cmd = CommandBuilder::new(&prepared_command.program);
    for a in &prepared_command.args {
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

    // Issue #524: agent カードに紐付く PTY のみ、出力 batch flush ごとに TeamHub の
    // `member_diagnostics[agent_id].last_pty_output_at` を update する observer を渡す。
    // ターミナルタブ等の agent_id 無し PTY では None で no-op。
    //
    // closure 内 dedup: 1 秒間隔でしか hub.state lock を取らない。flush は最短 16ms 間隔
    // (FLUSH_INTERVAL_MS) で起こり得るので、生の flush ごとに lock 取得すると `inject` /
    // `team_send` 等の MCP tool と競合して latency 悪化を招く。
    let on_output: Option<PtyOutputObserver> = opts.agent_id.as_ref().map(|aid| {
        let aid = aid.clone();
        let app_for_obs = app.clone();
        let last_update: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));
        Arc::new(move || {
            // dedup: 1 秒以内の連続 flush は no-op
            {
                let now = Instant::now();
                let mut guard = match last_update.try_lock() {
                    Ok(g) => g,
                    // 別 worker が ちょうど update 中なら今回はスキップ (1s 後に拾える)
                    Err(_) => return,
                };
                match *guard {
                    Some(prev) if now.duration_since(prev) < Duration::from_secs(1) => return,
                    _ => *guard = Some(now),
                }
            }
            // hub.state.lock() は async なので tokio task に逃がす (flush は同期 callback)
            let aid = aid.clone();
            let app = app_for_obs.clone();
            tauri::async_runtime::spawn(async move {
                let state = match app.try_state::<crate::state::AppState>() {
                    Some(s) => s,
                    None => {
                        tracing::trace!(
                            "[pty-observer] AppState not available; skipping last_pty_output_at update"
                        );
                        return;
                    }
                };
                let hub = state.team_hub.clone();
                let now_iso = chrono::Utc::now().to_rfc3339();
                let mut s = hub.state.lock().await;
                let diag = s.member_diagnostics.entry(aid).or_default();
                diag.last_pty_output_at = Some(now_iso);
            });
        }) as PtyOutputObserver
    });

    spawn_batcher(app.clone(), data_event, rx, scrollback.clone(), on_output);

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

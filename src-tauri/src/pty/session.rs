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
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
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
    /// Issue #632: PTY 寿命に bind した watcher cancel signal。`kill()` / `Drop` で
    /// `true` に flip され、`claude_watcher::spawn_watcher` が短い polling 間隔で
    /// 観測して即時 exit する。これにより「session が 1 秒で死んでも watcher が 60 秒
    /// 並走する」リソース蓄積を防ぐ。
    watcher_cancel: Arc<AtomicBool>,
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

    /// Issue #619: `injecting` フラグの現在値。テスト・診断用。
    /// 現状は `#[cfg(test)]` 配下からのみ使われるが、将来 diagnostics / tracing で参照する想定で
    /// `pub` のまま残す (`dead_code` 警告を抑止)。
    #[allow(dead_code)]
    pub fn is_injecting(&self) -> bool {
        self.injecting.load(std::sync::atomic::Ordering::Acquire)
    }

    /// Issue #619: RAII guard で `injecting` フラグを必ず `true` → `false` で対にする。
    ///
    /// 旧経路 (`team_hub::inject::inject_once` / `commands::terminal::inject_codex_prompt_to_pty`) は
    /// 早期 return / panic / `?` 経由で `set_injecting(false)` を呼び忘れる risk があり、
    /// bracketed paste の途中で worker terminal にユーザー入力が紛れ込む事故 (#619) を起こしていた。
    ///
    /// `begin_injecting()` の戻り値 (`InjectingGuard`) を変数に束縛しておけば、関数を抜ける
    /// あらゆる経路 (Ok 戻り / Err 戻り / panic) で Drop が走り、`injecting` が確実に false に戻る。
    pub fn begin_injecting(self: &Arc<Self>) -> InjectingGuard {
        InjectingGuard::new(self.clone())
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
        // Issue #632: kill 時点で watcher_cancel を立てる。これにより claude_watcher が
        // 60 秒 deadline まで待たずに即座 (短い polling 間隔以内で) exit する。
        self.watcher_cancel.store(true, Ordering::Release);
        let mut k = self
            .killer
            .lock()
            .map_err(|e| anyhow!("killer lock poisoned: {e}"))?;
        let _ = k.kill();
        Ok(())
    }

    /// Issue #632: claude_watcher が共有する cancel signal。`spawn_watcher` の caller
    /// (terminal_create) はこれを clone して watcher thread に渡す。session 寿命に追従して
    /// watcher を停止できる (= 60 秒 deadline での polling 漏れ問題を解消)。
    pub fn watcher_cancel_token(&self) -> Arc<AtomicBool> {
        self.watcher_cancel.clone()
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
/// が確実に成立する。kill 時の Mutex poison でも inner を回収し、child kill だけは試みる。
impl Drop for SessionHandle {
    fn drop(&mut self) {
        // Issue #632: 明示 kill() を経ずに drop されるパスでも watcher を解放する。
        // 例: registry::insert_if_absent が Err を返して caller 側が handle を捨てるとき、
        //     terminal_create の早期 return パスで insert に到達しないとき、等。
        self.watcher_cancel.store(true, Ordering::Release);
        let mut k = match self.killer.lock() {
            Ok(g) => g,
            Err(poisoned) => {
                tracing::warn!("[pty] SessionHandle killer mutex poisoned - recovering for drop kill");
                poisoned.into_inner()
            }
        };
        if let Err(e) = k.kill() {
            tracing::warn!(?e, "[pty] SessionHandle child kill failed during drop");
        }
    }
}

/// Issue #619: `SessionHandle::injecting` を「true → false」で必ずペアで操作するための RAII guard。
///
/// `SessionHandle::begin_injecting()` が返す。戻り値を変数に束縛している間 `injecting == true`
/// が維持され、変数のスコープを抜けた時点 (early return / panic / `?` 伝播 / 正常終了) で
/// `Drop` が走って `injecting == false` に必ず戻る。
///
/// 旧実装 (set_injecting(true) / set_injecting(false) を手動でペアで書く) は、
/// `inject_once` のように途中で多数の `?` / 早期 return / panic 経路があるコードでは
/// 1 箇所でも `set_injecting(false)` が抜けると `injecting` が `true` に貼り付き、
/// 以後その PTY のユーザー入力 (terminal_write 経路) が完全に無効化されたままになる
/// 可能性があった (#619 の根本原因の対称ケース)。
///
/// `Arc<SessionHandle>` を保持するのは `inject_once` の async 経路で session が drop されるより前に
/// guard 側で確実に reset したいため (Drop の時点で session が生きていることを保証する)。
pub struct InjectingGuard {
    session: Arc<SessionHandle>,
}

impl InjectingGuard {
    fn new(session: Arc<SessionHandle>) -> Self {
        session.set_injecting(true);
        Self { session }
    }
}

impl Drop for InjectingGuard {
    fn drop(&mut self) {
        // panic 経路 / 早期 return 経路 / 正常終了経路すべてで injecting=false に戻す。
        self.session.set_injecting(false);
    }
}

#[cfg(test)]
mod drop_tests {
    use super::*;
    use std::io::{Cursor, Result as IoResult};
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Debug, Clone)]
    struct CountingKiller {
        kills: Arc<AtomicUsize>,
    }

    impl portable_pty::ChildKiller for CountingKiller {
        fn kill(&mut self) -> IoResult<()> {
            self.kills.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
            Box::new(self.clone())
        }
    }

    struct DummyMaster;

    impl MasterPty for DummyMaster {
        fn resize(&self, _size: PtySize) -> std::result::Result<(), anyhow::Error> {
            Ok(())
        }

        fn get_size(&self) -> std::result::Result<PtySize, anyhow::Error> {
            Ok(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
        }

        fn try_clone_reader(
            &self,
        ) -> std::result::Result<Box<dyn Read + Send>, anyhow::Error> {
            Ok(Box::new(Cursor::new(Vec::<u8>::new())))
        }

        fn take_writer(&self) -> std::result::Result<Box<dyn Write + Send>, anyhow::Error> {
            Ok(Box::new(Vec::<u8>::new()))
        }

        #[cfg(unix)]
        fn process_group_leader(&self) -> Option<i32> {
            None
        }

        #[cfg(unix)]
        fn as_raw_fd(&self) -> Option<std::os::unix::io::RawFd> {
            None
        }

        #[cfg(unix)]
        fn tty_name(&self) -> Option<PathBuf> {
            None
        }
    }

    fn test_handle(kills: Arc<AtomicUsize>) -> SessionHandle {
        SessionHandle {
            writer: Mutex::new(Box::new(Vec::<u8>::new())),
            master: Mutex::new(Box::new(DummyMaster)),
            killer: Mutex::new(Box::new(CountingKiller { kills })),
            agent_id: None,
            session_key: None,
            team_id: None,
            role: None,
            cwd: String::new(),
            is_codex: false,
            injecting: std::sync::atomic::AtomicBool::new(false),
            write_budget: Mutex::new(WriteBudget {
                window_started_at: Instant::now(),
                bytes_in_window: 0,
            }),
            scrollback: crate::pty::scrollback::new_scrollback(),
            watcher_cancel: Arc::new(AtomicBool::new(false)),
        }
    }

    #[test]
    fn drop_recovers_poisoned_killer_mutex_and_kills_child() {
        let kills = Arc::new(AtomicUsize::new(0));
        let handle = test_handle(kills.clone());

        let _ = catch_unwind(AssertUnwindSafe(|| {
            let _guard = handle.killer.lock().unwrap();
            panic!("poison killer mutex");
        }));

        drop(handle);
        assert_eq!(kills.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn drop_kills_child_on_normal_path() {
        let kills = Arc::new(AtomicUsize::new(0));
        drop(test_handle(kills.clone()));
        assert_eq!(kills.load(Ordering::SeqCst), 1);
    }

    /// Issue #632: `kill()` で watcher_cancel が立つことを検証する。これにより
    /// claude_watcher が短い polling 間隔で session 終了を検知して即時 exit できる。
    #[test]
    fn kill_flips_watcher_cancel_token() {
        let kills = Arc::new(AtomicUsize::new(0));
        let handle = test_handle(kills);
        let token = handle.watcher_cancel_token();
        assert!(!token.load(Ordering::Acquire), "初期状態は false");
        handle.kill().expect("kill ok");
        assert!(
            token.load(Ordering::Acquire),
            "kill() 直後に watcher_cancel が true になっていること"
        );
    }

    /// Issue #632: 明示 kill() を経ずに Drop されたパスでも watcher_cancel が立つことを
    /// 検証する。registry::insert_if_absent が衝突で Err を返したときなど、caller が
    /// handle を捨てる経路で watcher が orphan として 60 秒残らないようにするため。
    #[test]
    fn drop_flips_watcher_cancel_token() {
        let kills = Arc::new(AtomicUsize::new(0));
        let handle = test_handle(kills);
        let token = handle.watcher_cancel_token();
        assert!(!token.load(Ordering::Acquire));
        drop(handle);
        assert!(
            token.load(Ordering::Acquire),
            "Drop 後に watcher_cancel が true になっていること"
        );
    }

    /// Issue #619: `begin_injecting()` の戻り値が drop されると `injecting` が必ず false に戻る。
    #[test]
    fn injecting_guard_resets_on_normal_drop() {
        let kills = Arc::new(AtomicUsize::new(0));
        let session = Arc::new(test_handle(kills));
        assert!(!session.is_injecting(), "initial state should be false");

        {
            let _guard = session.begin_injecting();
            assert!(session.is_injecting(), "guard should set injecting=true");
        } // _guard drops here

        assert!(
            !session.is_injecting(),
            "injecting must be reset to false after guard drop"
        );
    }

    /// Issue #619: 早期 return / `?` 伝播経路でも guard の Drop が走り false に戻る。
    /// クロージャを `?` で抜ける関数で wrap し、early return しても reset されることを確認。
    #[test]
    fn injecting_guard_resets_on_early_return() {
        let kills = Arc::new(AtomicUsize::new(0));
        let session = Arc::new(test_handle(kills));

        fn body(s: &Arc<SessionHandle>) -> std::result::Result<(), &'static str> {
            let _guard = s.begin_injecting();
            // 中で early return (Err) するパス
            Err("simulated early return")
        }

        let res = body(&session);
        assert!(res.is_err());
        assert!(
            !session.is_injecting(),
            "injecting must be false after early return path"
        );
    }

    /// Issue #619: panic 経路でも guard の Drop が走り false に戻る (RAII の本質)。
    #[test]
    fn injecting_guard_resets_on_panic() {
        let kills = Arc::new(AtomicUsize::new(0));
        let session = Arc::new(test_handle(kills));

        let s_for_panic = session.clone();
        let _ = catch_unwind(AssertUnwindSafe(move || {
            let _guard = s_for_panic.begin_injecting();
            assert!(s_for_panic.is_injecting());
            panic!("simulated panic during inject");
        }));

        assert!(
            !session.is_injecting(),
            "injecting must be false after panic unwind"
        );
    }

    /// Issue #619: ネストして begin_injecting を取った場合、外側 guard の生存中は内側 drop でも
    /// `set_injecting(false)` が無条件に走るため `false` になる。これは「inject_once は
    /// 同一 PTY で同時実行されない」前提のための設計 (現在 inject 経路は serialize されている)。
    /// テストはこの仕様を pin で固定する。
    #[test]
    fn injecting_guard_inner_drop_sets_false_even_when_outer_alive() {
        let kills = Arc::new(AtomicUsize::new(0));
        let session = Arc::new(test_handle(kills));

        let outer = session.begin_injecting();
        assert!(session.is_injecting());
        {
            let _inner = session.begin_injecting();
            assert!(session.is_injecting());
        }
        // 仕様: 内側 guard drop で injecting は false に戻る (= 同時 inject 想定外)
        assert!(!session.is_injecting());
        drop(outer);
        assert!(!session.is_injecting());
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
    if let Some(reason) = command_validation::reject_danger_flags(&args) {
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

pub(crate) fn resolve_terminal_command_path_for_check(command: &str) -> Result<PathBuf> {
    resolve_terminal_command_path_for_check_with_env(command, &HashMap::new())
}

fn resolve_terminal_command_path_for_check_with_env(
    command: &str,
    env: &HashMap<String, String>,
) -> Result<PathBuf> {
    #[cfg(windows)]
    {
        let pathext_raw = env_value(env, "PATHEXT");
        let pathext = windows_pathext(pathext_raw.as_deref());
        let search_dirs = windows_search_dirs(env);
        resolve_windows_command_path(command, &search_dirs, &pathext)
    }
    #[cfg(not(windows))]
    {
        let _ = env;
        which::which(command).map_err(Into::into)
    }
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

    if let Some(path) = env_value(env, "PATH") {
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
    let mut out = Vec::with_capacity(pathext.len() + 1);
    for ext in pathext {
        out.push(PathBuf::from(format!("{}{}", base.to_string_lossy(), ext)));
    }
    out.push(base.to_path_buf());
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
    fn prefers_cmd_over_extensionless_npm_shell_shim() {
        let tmp = tempfile::tempdir().unwrap();
        let shell_shim = tmp.path().join("codex");
        let cmd_shim = tmp.path().join("codex.cmd");
        std::fs::write(
            &shell_shim,
            "#!/bin/sh\nexec node \"$basedir/node_modules/.bin/codex\"\n",
        )
        .unwrap();
        std::fs::write(&cmd_shim, "@echo off\r\n").unwrap();
        let mut env = HashMap::new();
        env.insert(
            "PATH".to_string(),
            tmp.path().to_string_lossy().into_owned(),
        );
        env.insert("PATHEXT".to_string(), ".COM;.EXE;.BAT;.CMD".to_string());

        let prepared =
            resolve_windows_spawn_command("codex", vec!["--version".to_string()], &env).unwrap();

        assert_eq!(PathBuf::from(&prepared.resolved_command), cmd_shim);
        assert_eq!(
            Path::new(&prepared.program)
                .file_name()
                .and_then(|s| s.to_str())
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("cmd.exe")
        );
        assert_eq!(prepared.args[0], "/C");
        assert_eq!(PathBuf::from(&prepared.args[1]), cmd_shim);
        assert_eq!(prepared.args[2], "--version");
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

    #[test]
    fn readiness_check_uses_same_windows_fallback_dirs_as_spawn() {
        let home = tempfile::tempdir().unwrap();
        let claude_dir = home.path().join(".local").join("bin");
        std::fs::create_dir_all(&claude_dir).unwrap();
        let claude = claude_dir.join("claude.exe");
        std::fs::write(&claude, "").unwrap();

        let appdata = home.path().join("AppData").join("Roaming");
        let npm_dir = appdata.join("npm");
        std::fs::create_dir_all(&npm_dir).unwrap();
        let codex = npm_dir.join("codex.cmd");
        std::fs::write(&codex, "@echo off\r\n").unwrap();

        let mut env = HashMap::new();
        env.insert("PATH".to_string(), home.path().join("empty").to_string_lossy().into_owned());
        env.insert(
            "USERPROFILE".to_string(),
            home.path().to_string_lossy().into_owned(),
        );
        env.insert("APPDATA".to_string(), appdata.to_string_lossy().into_owned());
        env.insert(
            "LOCALAPPDATA".to_string(),
            home.path().join("LocalAppData").to_string_lossy().into_owned(),
        );

        assert_eq!(
            resolve_terminal_command_path_for_check_with_env("claude", &env).unwrap(),
            claude
        );
        assert_eq!(
            resolve_terminal_command_path_for_check_with_env("codex", &env).unwrap(),
            codex
        );
    }
}

#[cfg(test)]
mod spawn_metrics_tests {
    //! Issue #579: PTY spawn の所要時間ログ周りのユニットテスト。
    //!
    //! 実 PTY を立てる E2E は CI が遅いため避け、ヘルパ関数の単体挙動と
    //! 自前の captured-writer subscriber で `[pty] spawn ok` / `[pty] spawn failed`
    //! の出力を確認する軽量テストに留める。`tracing-test` を使わないのは、
    //! こちらの subscriber は `target: "pty"` を自分の crate filter で弾かない
    //! (test ローカルに `with_default` で全 target を拾う) ため。

    use super::*;
    use std::io::Write;
    use std::sync::{Arc, Mutex};
    use tracing_subscriber::fmt::MakeWriter;

    fn fixture(resolved: &str, requested: &str) -> PreparedSpawnCommand {
        PreparedSpawnCommand {
            requested_command: requested.to_string(),
            resolved_command: resolved.to_string(),
            program: resolved.to_string(),
            args: vec![],
            path_entries: 0,
            pathext_present: false,
        }
    }

    #[derive(Clone, Default)]
    struct CapturedWriter(Arc<Mutex<Vec<u8>>>);

    impl Write for CapturedWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'a> MakeWriter<'a> for CapturedWriter {
        type Writer = Self;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    fn capture<F: FnOnce()>(f: F) -> String {
        let writer = CapturedWriter::default();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(writer.clone())
            .with_max_level(tracing::Level::TRACE)
            .with_target(true)
            .with_ansi(false)
            .finish();
        tracing::subscriber::with_default(subscriber, f);
        let buf = writer.0.lock().unwrap().clone();
        String::from_utf8(buf).unwrap_or_default()
    }

    #[test]
    fn engine_label_picks_codex_when_flag_set() {
        assert_eq!(engine_label(true), "codex");
        assert_eq!(engine_label(false), "claude");
    }

    #[test]
    fn platform_label_returns_known_value() {
        let p = platform_label();
        assert!(matches!(p, "windows" | "macos" | "linux" | "other"));
    }

    #[test]
    fn build_cmd_label_strips_windows_path() {
        let prepared = fixture(r"C:\Users\foo\AppData\Roaming\npm\claude.cmd", "claude");
        assert_eq!(build_cmd_label(&prepared), "claude.cmd");
    }

    #[test]
    fn build_cmd_label_strips_unix_path() {
        let prepared = fixture("/usr/local/bin/codex", "codex");
        assert_eq!(build_cmd_label(&prepared), "codex");
    }

    #[test]
    fn build_cmd_label_falls_back_to_requested_when_resolved_empty() {
        let prepared = fixture("", "claude");
        assert_eq!(build_cmd_label(&prepared), "claude");
    }

    #[test]
    fn log_spawn_outcome_emits_info_on_success() {
        let logs = capture(|| {
            log_spawn_outcome("claude.cmd", "claude", "windows", 123, None);
        });
        // tracing-subscriber の既定 formatter は文字列フィールドを quote しないので
        // `engine=claude` のように key=value (no quotes) で照合する。集計用 grep の
        // 想定もこの形 (`Select-String 'engine=claude'`)。
        assert!(
            logs.contains("[pty] spawn ok"),
            "expected `[pty] spawn ok` in logs but got: {logs}"
        );
        assert!(logs.contains("elapsed_ms=123"), "logs: {logs}");
        assert!(logs.contains("engine=claude"), "logs: {logs}");
        assert!(logs.contains("platform=windows"), "logs: {logs}");
        assert!(logs.contains("command=claude.cmd"), "logs: {logs}");
        // target=pty が prefix 部分に出る (`INFO pty:` のような行になる)
        assert!(logs.contains("pty:"), "expected `pty:` target prefix: {logs}");
        // INFO レベルで出ていること (failed は warn)
        assert!(logs.contains("INFO"), "logs: {logs}");
        assert!(
            !logs.contains("[pty] spawn failed"),
            "success path emitted failure log: {logs}"
        );
    }

    #[test]
    fn log_spawn_outcome_emits_warn_on_failure() {
        let logs = capture(|| {
            log_spawn_outcome(
                "codex.cmd",
                "codex",
                "windows",
                456,
                Some("executable not found"),
            );
        });
        assert!(
            logs.contains("[pty] spawn failed"),
            "expected `[pty] spawn failed` in logs but got: {logs}"
        );
        assert!(logs.contains("elapsed_ms=456"), "logs: {logs}");
        assert!(logs.contains("engine=codex"), "logs: {logs}");
        assert!(
            logs.contains("error=executable not found"),
            "logs: {logs}"
        );
        // WARN レベルで出ていること
        assert!(logs.contains("WARN"), "logs: {logs}");
    }
}

/// Issue #579: spawn ログ用に「漏洩しない短い command ラベル」を作る。
///
/// resolved_command はフルパス (例: `C:\Users\foo\AppData\Roaming\npm\claude.cmd`) を
/// 持ちうるので、basename だけ取り出してさらに `redact_home` を通す。`Path::file_name`
/// は Unix 上で Windows 区切り `\` を解釈しないため、cross-platform に動かすには
/// 両方の区切りで rsplit する。
fn build_cmd_label(prepared: &PreparedSpawnCommand) -> String {
    let basename = prepared
        .resolved_command
        .rsplit(|c: char| c == '/' || c == '\\')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(prepared.requested_command.as_str())
        .to_string();
    redact_home(&basename)
}

fn engine_label(is_codex: bool) -> &'static str {
    if is_codex {
        "codex"
    } else {
        "claude"
    }
}

fn platform_label() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "other"
    }
}

/// Issue #579: PTY spawn の所要時間 + 結果を tracing で記録する。
/// 集計は `target=pty` + メッセージ `[pty] spawn ok` / `[pty] spawn failed` で grep する想定。
/// 詳細は `tasks/issue-579/notes.md` を参照。
fn log_spawn_outcome(
    cmd_label: &str,
    engine: &str,
    platform: &str,
    elapsed_ms: u64,
    error: Option<&str>,
) {
    match error {
        None => tracing::info!(
            target: "pty",
            command = %cmd_label,
            engine = %engine,
            platform = %platform,
            elapsed_ms = elapsed_ms,
            "[pty] spawn ok"
        ),
        Some(err) => tracing::warn!(
            target: "pty",
            command = %cmd_label,
            engine = %engine,
            platform = %platform,
            elapsed_ms = elapsed_ms,
            error = %err,
            "[pty] spawn failed"
        ),
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

    // Issue #579: PTY spawn 所要時間を計測してログに出す。
    // Windows ConPTY + cmd.exe + npm shim 経由の起動コストの p50/p95 を取るのが目的。
    // 失敗パスでも elapsed_ms を残すため `?` ではなく match で分岐する。
    let cmd_label = build_cmd_label(&prepared_command);
    let engine = engine_label(opts.is_codex);
    let platform = platform_label();
    let started = Instant::now();
    let spawn_result = pair.slave.spawn_command(cmd);
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let mut child = match spawn_result {
        Ok(child) => {
            log_spawn_outcome(&cmd_label, engine, platform, elapsed_ms, None);
            child
        }
        Err(err) => {
            let err_string = err.to_string();
            log_spawn_outcome(&cmd_label, engine, platform, elapsed_ms, Some(&err_string));
            return Err(err.into());
        }
    };
    drop(pair.slave);

    let killer = child.clone_killer();

    // reader thread (blocking IO -> mpsc)
    let mut reader = pair.master.try_clone_reader()?;
    let mut writer = pair.master.take_writer()?;

    // Issue #618: Windows ConPTY で cmd.exe / PowerShell を起動する場合、最初に
    // `chcp 65001` 等を inject してシェル出力を UTF-8 に強制する。これをしないと
    // 既定の OEM コードページ (CP932 / ja-JP) で動くシェルが書き出すバイト列を
    // batcher が `String::from_utf8_lossy` でそのまま UTF-8 として解釈してしまい、
    // `dir` の漢字ファイル名 / `python -c "print('日本語')"` の出力が全 U+FFFD に
    // 化ける (`#120` で files 経路に入れた CP932 デコードは PTY には届いていない)。
    //
    // inject 失敗は致命的ではない (子プロセス側の stdin が EOF / 既に閉じている等):
    // tracing::warn! でログだけ残して spawn は続行する。
    if cfg!(windows) {
        let force_utf8 = command_validation::settings_terminal_force_utf8();
        match maybe_inject_windows_utf8_init(&mut *writer, &opts.command, force_utf8) {
            Ok(Some(injected)) => tracing::info!(
                "[pty] Windows UTF-8 init command injected (command={}, len={})",
                opts.command,
                injected.len()
            ),
            Ok(None) => {} // not applicable / disabled — no-op
            Err(e) => tracing::warn!(
                "[pty] Windows UTF-8 init command write failed (command={}): {}",
                opts.command,
                e
            ),
        }
    }

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
        // Issue #632: watcher cancel token は session 起動と同寿命。kill() / Drop で flip。
        watcher_cancel: Arc::new(AtomicBool::new(false)),
    })
}

/// Issue #618: Windows ConPTY 起動直後に shell の出力 codepage を UTF-8 に強制する初期コマンドを
/// `writer` (PTY master) に流すヘルパー。`force_utf8` が false、対象シェルが cmd / pwsh /
/// powershell でないとき、または `command_validation::windows_utf8_init_command` が None を
/// 返すとき (= bash / sh / nu / claude / codex / 不明シェル) は no-op で `Ok(None)`。
///
/// 戻り値は inject されたバイト列の参照 (test 用、failure path と区別するため `Result<Option>`):
///   - `Ok(Some(bytes))`: bytes が writer に書き込まれた
///   - `Ok(None)`: no-op (force_utf8=false / 対象外シェル)
///   - `Err(io::Error)`: writer.write_all / writer.flush 失敗
///
/// platform check (`cfg!(windows)`) は呼び出し側で行う想定。本関数自体は platform-agnostic で
/// テスト時も統一的に動く (Linux CI でも `cmd` を渡せば bytes を返す)。
fn maybe_inject_windows_utf8_init(
    writer: &mut dyn Write,
    command: &str,
    force_utf8: bool,
) -> std::io::Result<Option<&'static [u8]>> {
    if !force_utf8 {
        return Ok(None);
    }
    let Some(init) = command_validation::windows_utf8_init_command(command) else {
        return Ok(None);
    };
    writer.write_all(init)?;
    writer.flush()?;
    Ok(Some(init))
}

/// Issue #618: Windows + cmd.exe で `chcp 65001` 後に `dir` が漢字ファイル名を UTF-8 で
/// 吐くことを実機で確認する integration test。
///
/// **重要**: `cmd.exe /D /Q /C "chcp 65001 && dir"` のような 1 ショット混合では、cmd.exe が
/// `/C` 起動時に固定した OEM codepage を内部 `dir` に引き継いでしまうため UTF-8 化されない。
/// 一方、本 PR の prod 経路 (spawn_session 内で writer.write_all による inject) は対話的な
/// cmd.exe に対し独立したコマンドとして `chcp 65001\r` → ユーザーの `dir\r` を流すため正しく
/// 切り替わる。本 test では同じセマンティクス (= stdin パイプで chcp と dir を順番に流す)
/// を `std::process::Command` の piped stdin で再現して検証する。
///
/// CI では走らせず (`#[ignore]`)、ローカル Windows 環境で
/// `cargo test ... -- --ignored issue_618` で実行する想定。
#[cfg(test)]
#[cfg(windows)]
mod windows_utf8_e2e_tests {
    use std::io::Write;
    use std::process::{Command, Stdio};

    /// chcp + dir を **別々のコマンド** として cmd.exe にパイプで流す。これは prod 経路の
    /// PTY writer による sequential inject と同じセマンティクス。
    #[test]
    #[ignore = "requires Windows + cmd.exe; run manually via -- --ignored"]
    fn issue_618_dir_displays_japanese() {
        // 1) 一時ディレクトリ + 漢字ファイル
        let tmp = std::env::temp_dir().join(format!("vibe-issue-618-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).expect("mkdir tmp");
        let jp_file = tmp.join("テスト_漢字_618.txt");
        std::fs::write(&jp_file, b"hello").expect("write jp file");

        // 2) cmd.exe /D /Q を起動し、stdin に chcp + dir + exit を順番に流す
        let mut child = Command::new("cmd.exe")
            .args(["/D", "/Q"])
            .current_dir(&tmp)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn cmd.exe failed (PATH に cmd.exe が無い?)");

        // stdin 経由で sequential 入力。これが prod の PTY writer 経由 inject と等価。
        {
            let stdin = child.stdin.as_mut().expect("stdin");
            // prod 経路と同じバイト列を流す (chcp 65001 > nul + dir + exit)
            stdin.write_all(b"chcp 65001 > nul\r\n").expect("write chcp");
            stdin.write_all(b"dir\r\n").expect("write dir");
            stdin.write_all(b"exit\r\n").expect("write exit");
            stdin.flush().expect("flush stdin");
        }

        let output = child.wait_with_output().expect("wait child");
        let stdout_lossy = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr_lossy = String::from_utf8_lossy(&output.stderr).to_string();
        eprintln!(
            "[issue-618 e2e] exit={:?} stdout={} bytes\n--- stdout ---\n{}\n--- stderr ---\n{}",
            output.status.code(),
            output.stdout.len(),
            stdout_lossy,
            stderr_lossy
        );

        // 3) lossy UTF-8 decode しても U+FFFD で化けず、漢字ファイル名がそのまま含まれること
        assert!(output.status.success(), "cmd.exe exited non-zero");
        assert!(!output.stdout.is_empty(), "expected non-empty dir output");
        assert!(
            !stdout_lossy.contains("\u{FFFD}_618.txt"),
            "expected Japanese filename in UTF-8 (no U+FFFD before _618.txt), got:\n{stdout_lossy}"
        );
        assert!(
            stdout_lossy.contains("テスト_漢字_618.txt"),
            "expected exact Japanese filename in UTF-8 dir output, got:\n{stdout_lossy}"
        );

        // cleanup
        let _ = std::fs::remove_file(&jp_file);
        let _ = std::fs::remove_dir(&tmp);
    }

    /// 対比用: chcp 65001 を入れず、素の cmd.exe で `dir` を流すと CP932 で書かれ、
    /// `String::from_utf8_lossy` で漢字が U+FFFD に化けることを示す。
    /// host が既に UTF-8 codepage の場合 (例: chcp 65001 が host グローバルに効いている / ja 以外
    /// の locale) はこの baseline が成立しないので、その時は assertion をスキップして pass させる。
    #[test]
    #[ignore = "requires Windows + cmd.exe (CP932 default); run manually via -- --ignored"]
    fn issue_618_baseline_without_chcp_corrupts_japanese() {
        let tmp = std::env::temp_dir().join(format!("vibe-issue-618-base-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).expect("mkdir tmp");
        let jp_file = tmp.join("テスト_漢字_618.txt");
        std::fs::write(&jp_file, b"hello").expect("write jp file");

        // chcp なしで dir
        let mut child = Command::new("cmd.exe")
            .args(["/D", "/Q"])
            .current_dir(&tmp)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn cmd.exe failed");
        {
            let stdin = child.stdin.as_mut().expect("stdin");
            stdin.write_all(b"dir\r\n").expect("write dir");
            stdin.write_all(b"exit\r\n").expect("write exit");
        }
        let output = child.wait_with_output().expect("wait child");
        let stdout_lossy = String::from_utf8_lossy(&output.stdout).to_string();

        eprintln!(
            "[issue-618 e2e baseline] {} bytes, decoded as UTF-8:\n{}",
            output.stdout.len(),
            stdout_lossy
        );
        assert!(output.status.success());
        assert!(!output.stdout.is_empty());

        // host の active codepage を確認。932 のときだけ U+FFFD を期待 (= baseline 条件).
        let active_cp = Command::new("cmd.exe")
            .args(["/D", "/Q", "/C", "chcp"])
            .output()
            .expect("chcp query");
        let cp_str = String::from_utf8_lossy(&active_cp.stdout).to_string();
        eprintln!("[issue-618 e2e baseline] active codepage: {}", cp_str.trim());
        if cp_str.contains("932") {
            assert!(
                stdout_lossy.contains("\u{FFFD}"),
                "on CP932 host expected U+FFFD in lossy-UTF8 decode, got:\n{stdout_lossy}"
            );
        }

        let _ = std::fs::remove_file(&jp_file);
        let _ = std::fs::remove_dir(&tmp);
    }
}

#[cfg(test)]
mod windows_utf8_inject_tests {
    use super::maybe_inject_windows_utf8_init;
    use std::io;

    /// 書き込みが必ず失敗する Writer (write_all 試行で error を返す)。
    /// inject failure path のログを検証するための test double。
    struct FailingWriter;

    impl io::Write for FailingWriter {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::Error::new(io::ErrorKind::BrokenPipe, "test EPIPE"))
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn writes_chcp_for_cmd_when_enabled() {
        let mut buf: Vec<u8> = Vec::new();
        let res = maybe_inject_windows_utf8_init(&mut buf, "cmd", true).unwrap();
        assert_eq!(res, Some(&b"chcp 65001 > nul\r"[..]));
        assert_eq!(buf, b"chcp 65001 > nul\r");
    }

    #[test]
    fn writes_chcp_for_cmd_exe_full_path() {
        let mut buf: Vec<u8> = Vec::new();
        let res =
            maybe_inject_windows_utf8_init(&mut buf, r"C:\Windows\System32\cmd.exe", true).unwrap();
        assert!(res.is_some());
        assert_eq!(buf, b"chcp 65001 > nul\r");
    }

    #[test]
    fn writes_combined_init_for_powershell() {
        let mut buf: Vec<u8> = Vec::new();
        let res = maybe_inject_windows_utf8_init(&mut buf, "powershell", true).unwrap();
        assert!(res.is_some());
        let s = std::str::from_utf8(&buf).unwrap();
        assert!(s.contains("[Console]::OutputEncoding"));
        assert!(s.contains("UTF8Encoding"));
        assert!(s.contains("chcp 65001"));
        assert!(s.contains("> $null"));
        assert!(s.ends_with("\r"));
    }

    #[test]
    fn writes_combined_init_for_pwsh() {
        let mut buf: Vec<u8> = Vec::new();
        let res = maybe_inject_windows_utf8_init(&mut buf, "pwsh", true).unwrap();
        assert!(res.is_some());
        let s = std::str::from_utf8(&buf).unwrap();
        assert!(s.contains("[Console]::OutputEncoding"));
    }

    #[test]
    fn no_op_when_force_utf8_false() {
        let mut buf: Vec<u8> = Vec::new();
        let res = maybe_inject_windows_utf8_init(&mut buf, "cmd", false).unwrap();
        assert!(res.is_none());
        assert!(buf.is_empty(), "writer should not be touched when disabled");
    }

    #[test]
    fn no_op_for_bash() {
        let mut buf: Vec<u8> = Vec::new();
        let res = maybe_inject_windows_utf8_init(&mut buf, "bash", true).unwrap();
        assert!(res.is_none());
        assert!(buf.is_empty());
    }

    #[test]
    fn no_op_for_zsh_fish_nu() {
        for shell in ["zsh", "fish", "nu", "/usr/bin/zsh"] {
            let mut buf: Vec<u8> = Vec::new();
            let res = maybe_inject_windows_utf8_init(&mut buf, shell, true).unwrap();
            assert!(res.is_none(), "expected no-op for {shell}");
            assert!(buf.is_empty(), "expected empty buf for {shell}");
        }
    }

    #[test]
    fn no_op_for_claude_and_codex() {
        // Issue #618: Claude / Codex CLI は内部で UTF-8 出力するので chcp inject すると
        // CLI 側の prompt / banner と衝突する懸念があるため対象外。
        for cli in ["claude", "codex", r"C:\tools\codex.exe", "/usr/local/bin/claude"] {
            let mut buf: Vec<u8> = Vec::new();
            let res = maybe_inject_windows_utf8_init(&mut buf, cli, true).unwrap();
            assert!(res.is_none(), "expected no-op for {cli}");
        }
    }

    #[test]
    fn no_op_for_empty_or_unknown_command() {
        for cmd in ["", "nonexistent-shell"] {
            let mut buf: Vec<u8> = Vec::new();
            let res = maybe_inject_windows_utf8_init(&mut buf, cmd, true).unwrap();
            assert!(res.is_none(), "expected no-op for {:?}", cmd);
        }
    }

    #[test]
    fn propagates_write_error() {
        let mut writer = FailingWriter;
        let res = maybe_inject_windows_utf8_init(&mut writer, "cmd", true);
        assert!(res.is_err(), "writer error should bubble up");
        assert_eq!(res.unwrap_err().kind(), io::ErrorKind::BrokenPipe);
    }
}

//! Issue #738: 1 セッションぶんの PTY 状態 (`SessionHandle`) と関連型。
//!
//! 旧 `session.rs` から `SessionHandle` / `UserWriteOutcome` / `TerminalExitInfo` と
//! その `impl` / `Drop` を切り出したもの。挙動 (write / user_write / resize / kill /
//! Drop 時の child kill / Mutex poison 時の recover) は一切変えていない。
//!
//! 4 つの `std::sync::Mutex` (`writer` / `master` / `killer` / `write_budget`) の
//! lock 取得は `super::lock::lock_poisoned!` macro に集約した。

use crate::pty::scrollback::{
    scrollback_to_string, Scrollback, WriteBudget, MAX_TERMINAL_WRITE_BYTES_PER_CALL,
    MAX_TERMINAL_WRITE_BYTES_PER_SEC, TERMINAL_WRITE_WINDOW,
};
use anyhow::Result;
use portable_pty::{MasterPty, PtySize};
use serde::Serialize;
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::injecting_guard::InjectingGuard;
use super::lock::{lock_poisoned, LockResult};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitInfo {
    pub exit_code: i64,
    pub signal: Option<i32>,
}

/// 1 セッションぶんの状態。kill / write / resize 用に master と writer を Mutex 保持。
pub struct SessionHandle {
    /// 旧 Session.pty.write 相当
    pub(super) writer: Mutex<Box<dyn Write + Send>>,
    /// resize 用に保持
    pub(super) master: Mutex<Box<dyn MasterPty + Send>>,
    /// kill 用 (子プロセス側 — drop で殺せないことがあるため明示保持)
    pub(super) killer: Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
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
    pub(super) injecting: AtomicBool,
    /// Issue #214: terminal_write の 1 端末ごとのレート制限。
    pub(super) write_budget: Mutex<WriteBudget>,
    /// Issue #285 follow-up: attach 経路で renderer に過去出力を replay するための
    /// 直近 64 KiB の出力リングバッファ。`spawn_batcher` の flush で更新される。
    pub(super) scrollback: Scrollback,
    /// Issue #632: PTY 寿命に bind した watcher cancel signal。`kill()` / `Drop` で
    /// `true` に flip され、`claude_watcher::spawn_watcher` が短い polling 間隔で
    /// 観測して即時 exit する。これにより「session が 1 秒で死んでも watcher が 60 秒
    /// 並走する」リソース蓄積を防ぐ。
    pub(super) watcher_cancel: Arc<AtomicBool>,
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
        let mut w = lock_poisoned!(self.writer, "writer")?;
        w.write_all(data)?;
        w.flush()?;
        Ok(())
    }

    /// Issue #153 / #214:
    /// - inject 中は drop
    /// - 1 回の payload は 64 KiB 上限
    /// - 1 秒あたり 256 KiB を超える入力は drop
    pub fn user_write(&self, data: &[u8]) -> Result<UserWriteOutcome> {
        if self.injecting.load(Ordering::Acquire) {
            return Ok(UserWriteOutcome::SuppressedInjecting);
        }
        if data.len() > MAX_TERMINAL_WRITE_BYTES_PER_CALL {
            return Ok(UserWriteOutcome::DroppedTooLarge);
        }
        {
            let mut budget = lock_poisoned!(self.write_budget, "write_budget")?;
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
        self.injecting.store(on, Ordering::Release);
    }

    /// Issue #619: `injecting` フラグの現在値。テスト・診断用。
    /// 現状は `#[cfg(test)]` 配下からのみ使われるが、将来 diagnostics / tracing で参照する想定で
    /// `pub` のまま残す (`dead_code` 警告を抑止)。
    #[allow(dead_code)]
    pub fn is_injecting(&self) -> bool {
        self.injecting.load(Ordering::Acquire)
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
        let m = lock_poisoned!(self.master, "master")?;
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
        let mut k = lock_poisoned!(self.killer, "killer")?;
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
        // Issue #738: poison していても child kill は試みたいので、`lock_poisoned!` macro
        // (anyhow に落とす) ではなく生の `LockResult` を受けて `into_inner()` で recover する。
        let killer_lock: LockResult<'_, _> = self.killer.lock();
        let mut k = match killer_lock {
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

#[cfg(test)]
mod drop_tests {
    use super::*;
    use portable_pty::PtySize;
    use std::io::{Cursor, Read, Result as IoResult, Write};
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
        fn tty_name(&self) -> Option<std::path::PathBuf> {
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
            injecting: AtomicBool::new(false),
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

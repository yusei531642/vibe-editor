// In-flight inject task tracker
//
// Issue #630: window CloseRequested handler が `state.pty_registry.kill_all()` を即座に呼ぶと、
// `tauri::async_runtime::spawn` 上で進行中の `inject_codex_prompt_to_pty` や `team_send` 経由の
// `inject::inject` が PTY write 中に kill されて、SessionHandle::drop の killer Mutex poison /
// 半端 inject による不正出力 / reader thread 解放漏れ等の race を起こす。
//
// 設計:
//   - `InFlightTracker` が「現在何件の inject task が走っているか」を `AtomicUsize` で持つ。
//   - 各 inject 経路の入口で `track_async(future)` / `spawn(future)` 経由で計上、`Drop` で減算。
//     減算と同時に内部 `Notify` を `notify_waiters()` してウェイターを起こす。
//   - CloseRequested handler 側は `wait_idle(timeout)` を `await` し、counter が 0 になるか
//     timeout までブロック (既定 3s)。完了 (timeout 含む) 後に `kill_all` → `app.exit(0)` する。
//
// 利用方針:
//   - `inject_codex_prompt_to_pty` の fire-and-forget spawn (`commands/terminal.rs`) は
//     `tracker.spawn(future)` で計上して spawn する。
//   - `team_send` の中の `JoinSet::spawn(inject::inject(...))` は inject() 自体を `track_async`
//     で囲んで計上する (この経路は inject() の出口まで JoinSet が await されるが、外側の
//     handle_client task が close 時にキャンセルされる可能性があるため tracker 上は明示計上)。
//   - `team_send_retry_inject` (IPC 経路) も同様に `track_async` で囲む。

use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::async_runtime::JoinHandle;
use tokio::sync::Notify;

/// in-flight inject task の件数を持つ tracker。
///
/// 並行性は `AtomicUsize` のみで十分 (Notify 自体が thread-safe)。`InFlightGuard` の `Drop`
/// 経由で確実に減算するため、tracked future の panic / cancel どの経路でも counter がリーク
/// しない。
#[derive(Default)]
pub struct InFlightTracker {
    /// 現在 in-flight な tracked future の本数。
    count: AtomicUsize,
    /// counter が 0 に落ちたとき waiter を起こす。
    idle: Notify,
}

/// `InFlightTracker::enter()` で発行される RAII guard。`Drop` で counter を減算し、
/// 0 に落ちたら `Notify::notify_waiters()` で wait_idle を解放する。
///
/// pin-projection を避けるため、tracked future ラッパは作らず「guard を future の中で
/// `move` で抱える」スタイル (`async move { let _g = guard; ... }`) で利用する。
pub struct InFlightGuard {
    tracker: Arc<InFlightTracker>,
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        let prev = self.tracker.count.fetch_sub(1, Ordering::SeqCst);
        debug_assert!(prev > 0, "InFlightTracker counter underflowed");
        if prev == 1 {
            self.tracker.idle.notify_waiters();
        }
    }
}

impl InFlightTracker {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// `count` の現在値を取得 (主にテスト / tracing 用)。
    pub fn current(&self) -> usize {
        self.count.load(Ordering::SeqCst)
    }

    /// counter を 1 加算し、解放用 RAII guard を返す。caller は guard を future / closure 内に
    /// move で抱えること。guard が drop された瞬間に counter が減算されるため、guard を捨てる
    /// タイミング = 「タスクが完了した」タイミングになる。
    pub fn enter(self: &Arc<Self>) -> InFlightGuard {
        self.count.fetch_add(1, Ordering::SeqCst);
        InFlightGuard {
            tracker: Arc::clone(self),
        }
    }

    /// `f` を tracked future としてラップする。`f.await` の出口で guard が drop され counter が
    /// 戻る。tracked future が await されないまま drop されても (caller が tokio::select! で
    /// branch から外したケース等) counter は正しく戻る。
    ///
    /// 計上タイミングは「`track_async` 呼び出し時 = 即時」。
    pub fn track_async<F>(self: &Arc<Self>, f: F) -> impl Future<Output = F::Output>
    where
        F: Future,
    {
        let guard = self.enter();
        async move {
            let _g = guard;
            f.await
        }
    }

    /// fire-and-forget spawn 用ヘルパ。`tauri::async_runtime::spawn` で起動するが、tracker 配下
    /// に置く。返り値の JoinHandle は caller 側で破棄してよい。
    pub fn spawn<F>(self: &Arc<Self>, fut: F) -> JoinHandle<F::Output>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        let guard = self.enter();
        tauri::async_runtime::spawn(async move {
            let _g = guard;
            fut.await
        })
    }

    /// counter が 0 に落ちるか `timeout` 経過するまで待つ。先に 0 に落ちれば `true`、timeout で
    /// 抜けたら `false` を返す (timeout 後に counter 0 ならそれも `true`)。
    ///
    /// 呼び出し時点で counter が 0 なら即時 `true`。Notify は `notify_waiters` で broadcast する
    /// 設計のため、wait に入るより前に `notify_waiters` が呼ばれていても次回ループで現値を見て
    /// 抜ける (`notified()` を作ったあと再判定するパターン)。
    pub async fn wait_idle(&self, timeout: Duration) -> bool {
        if self.count.load(Ordering::SeqCst) == 0 {
            return true;
        }
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            // notified() を先に作っておくことで、enter() → drop の race で「我々が wait に入る
            // 前に notify_waiters が呼ばれた」場合でも、次回 await で確実に取りこぼさない。
            let notified = self.idle.notified();
            if self.count.load(Ordering::SeqCst) == 0 {
                return true;
            }
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return self.count.load(Ordering::SeqCst) == 0;
            }
            tokio::select! {
                _ = notified => {
                    // 0 になったかは次回ループ頭で再判定する (race を避けるため)。
                    continue;
                }
                _ = tokio::time::sleep(remaining) => {
                    return self.count.load(Ordering::SeqCst) == 0;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn wait_idle_returns_immediately_when_no_tasks() {
        let t = InFlightTracker::new();
        assert!(t.wait_idle(Duration::from_millis(50)).await);
        assert_eq!(t.current(), 0);
    }

    #[tokio::test]
    async fn track_async_increments_and_decrements_counter() {
        let t = InFlightTracker::new();
        let fut = t.track_async(async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            42
        });
        assert_eq!(t.current(), 1);
        let v = fut.await;
        assert_eq!(v, 42);
        assert_eq!(t.current(), 0);
    }

    #[tokio::test]
    async fn wait_idle_unblocks_on_completion() {
        let t = InFlightTracker::new();
        let t2 = Arc::clone(&t);
        let _h = t.spawn(async move {
            tokio::time::sleep(Duration::from_millis(30)).await;
        });
        assert_eq!(t2.current(), 1);
        let started = std::time::Instant::now();
        let ok = t2.wait_idle(Duration::from_secs(2)).await;
        assert!(ok, "wait_idle should return true on natural completion");
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "should not wait full timeout when task finishes early"
        );
        assert_eq!(t2.current(), 0);
    }

    #[tokio::test]
    async fn wait_idle_returns_false_on_timeout() {
        let t = InFlightTracker::new();
        let _h = t.spawn(async move {
            tokio::time::sleep(Duration::from_secs(5)).await;
        });
        let ok = t.wait_idle(Duration::from_millis(50)).await;
        assert!(!ok, "wait_idle should return false when tasks still running");
        // 残ったタスクは 1 件のまま (timeout は kill しない)
        assert_eq!(t.current(), 1);
    }

    #[tokio::test]
    async fn drop_without_polling_still_decrements() {
        let t = InFlightTracker::new();
        {
            let _fut = t.track_async(async {
                tokio::time::sleep(Duration::from_secs(10)).await;
            });
            assert_eq!(t.current(), 1);
            // _fut は scope 終了で drop される
        }
        assert_eq!(t.current(), 0);
        assert!(t.wait_idle(Duration::from_millis(10)).await);
    }

    #[tokio::test]
    async fn multiple_tasks_drain_correctly() {
        let t = InFlightTracker::new();
        let mut handles = Vec::new();
        for _ in 0..5 {
            let h = t.spawn(async move {
                tokio::time::sleep(Duration::from_millis(20)).await;
            });
            handles.push(h);
        }
        assert_eq!(t.current(), 5);
        let ok = t.wait_idle(Duration::from_secs(2)).await;
        assert!(ok);
        assert_eq!(t.current(), 0);
    }

    #[tokio::test]
    async fn enter_guard_decrements_on_explicit_drop() {
        let t = InFlightTracker::new();
        let g = t.enter();
        assert_eq!(t.current(), 1);
        drop(g);
        assert_eq!(t.current(), 0);
    }
}

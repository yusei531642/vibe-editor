//! Structured background task supervision.
//!
//! Issue #952: watcher / cleanup / poller 系の background work がそれぞれ
//! AtomicBool, generation counter, detached thread, in-flight counter を個別に持っていた。
//! この module は「cancel token を登録して、終了時に cancel → bounded wait する」ための
//! 共通部品を提供する。

use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};
use tauri::async_runtime::JoinHandle;
use tauri::Manager;
use tokio::sync::Notify;

#[derive(Clone, Debug)]
pub struct CancellationToken {
    cancelled: Arc<AtomicBool>,
}

impl CancellationToken {
    pub fn new() -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn from_atomic(cancelled: Arc<AtomicBool>) -> Self {
        Self { cancelled }
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    fn weak(&self) -> Weak<AtomicBool> {
        Arc::downgrade(&self.cancelled)
    }
}

impl Default for CancellationToken {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Default)]
pub struct TaskSupervisor {
    count: AtomicUsize,
    idle: Notify,
    cancel_tokens: Mutex<Vec<Weak<AtomicBool>>>,
}

pub struct TaskGuard {
    supervisor: Arc<TaskSupervisor>,
}

impl Drop for TaskGuard {
    fn drop(&mut self) {
        let prev = self.supervisor.count.fetch_sub(1, Ordering::SeqCst);
        debug_assert!(prev > 0, "TaskSupervisor counter underflowed");
        if prev == 1 {
            self.supervisor.idle.notify_waiters();
        }
    }
}

impl TaskSupervisor {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn current(&self) -> usize {
        self.count.load(Ordering::SeqCst)
    }

    pub fn cancellation_token(self: &Arc<Self>) -> CancellationToken {
        let token = CancellationToken::new();
        self.register_cancel_token(&token);
        token
    }

    pub fn register_cancel_token(&self, token: &CancellationToken) {
        if let Ok(mut tokens) = self.cancel_tokens.lock() {
            tokens.retain(|t| t.strong_count() > 0);
            tokens.push(token.weak());
        }
    }

    pub fn cancel_all(&self) {
        if let Ok(mut tokens) = self.cancel_tokens.lock() {
            tokens.retain(|token| {
                if let Some(cancelled) = token.upgrade() {
                    CancellationToken { cancelled }.cancel();
                    true
                } else {
                    false
                }
            });
        }
    }

    pub fn enter(self: &Arc<Self>) -> TaskGuard {
        self.count.fetch_add(1, Ordering::SeqCst);
        TaskGuard {
            supervisor: Arc::clone(self),
        }
    }

    pub fn track_async<F>(self: &Arc<Self>, f: F) -> impl Future<Output = F::Output>
    where
        F: Future,
    {
        let guard = self.enter();
        async move {
            let _guard = guard;
            f.await
        }
    }

    pub fn spawn<F>(self: &Arc<Self>, fut: F) -> JoinHandle<F::Output>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        let guard = self.enter();
        tauri::async_runtime::spawn(async move {
            let _guard = guard;
            fut.await
        })
    }

    pub fn spawn_thread<F, T>(
        self: &Arc<Self>,
        name: impl Into<String>,
        token: CancellationToken,
        f: F,
    ) -> std::io::Result<std::thread::JoinHandle<T>>
    where
        F: FnOnce(CancellationToken) -> T + Send + 'static,
        T: Send + 'static,
    {
        self.register_cancel_token(&token);
        let guard = self.enter();
        std::thread::Builder::new()
            .name(name.into())
            .spawn(move || {
                let _guard = guard;
                f(token)
            })
    }

    pub async fn wait_idle(&self, timeout: Duration) -> bool {
        if self.current() == 0 {
            return true;
        }
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let notified = self.idle.notified();
            if self.current() == 0 {
                return true;
            }
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return self.current() == 0;
            }
            tokio::select! {
                _ = notified => continue,
                _ = tokio::time::sleep(remaining) => return self.current() == 0,
            }
        }
    }

    pub async fn shutdown(&self, timeout: Duration) -> bool {
        self.cancel_all();
        self.wait_idle(timeout).await
    }

    pub fn join_blocking_jobs<T, F>(
        name: &'static str,
        jobs: Vec<T>,
        timeout: Duration,
        run: F,
    ) -> usize
    where
        T: Send + 'static,
        F: Fn(T) + Send + Sync + 'static,
    {
        if jobs.is_empty() {
            return 0;
        }
        let total = jobs.len();
        let runner = Arc::new(run);
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        for job in jobs {
            let tx = tx.clone();
            let runner = Arc::clone(&runner);
            let spawn_result =
                std::thread::Builder::new()
                    .name(name.to_string())
                    .spawn(move || {
                        runner(job);
                        let _ = tx.send(());
                    });
            if let Err(e) = spawn_result {
                tracing::warn!("[task_supervisor] failed to spawn {name}: {e}");
            }
        }
        drop(tx);

        let deadline = Instant::now() + timeout;
        let mut done = 0usize;
        while done < total {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match rx.recv_timeout(remaining) {
                Ok(()) => done += 1,
                Err(_) => break,
            }
        }
        done
    }
}

pub(crate) fn spawn_app_thread<F>(
    app: tauri::AppHandle,
    name: &'static str,
    cancelled: Arc<AtomicBool>,
    f: F,
) where
    F: FnOnce() + Send + 'static,
{
    let supervisor = app
        .state::<crate::state::AppState>()
        .task_supervisor
        .clone();
    let token = CancellationToken::from_atomic(cancelled);
    if let Err(e) = supervisor.spawn_thread(name, token, move |_| f()) {
        tracing::warn!("[task_supervisor] failed to spawn {name}: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn wait_idle_returns_immediately_when_no_tasks() {
        let supervisor = TaskSupervisor::new();
        assert!(supervisor.wait_idle(Duration::from_millis(50)).await);
        assert_eq!(supervisor.current(), 0);
    }

    #[tokio::test]
    async fn track_async_increments_and_decrements_counter() {
        let supervisor = TaskSupervisor::new();
        let fut = supervisor.track_async(async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            42
        });
        assert_eq!(supervisor.current(), 1);
        let value = fut.await;
        assert_eq!(value, 42);
        assert_eq!(supervisor.current(), 0);
    }

    #[tokio::test]
    async fn shutdown_cancels_registered_thread_token() {
        let supervisor = TaskSupervisor::new();
        let token = supervisor.cancellation_token();
        let handle = supervisor
            .spawn_thread("task-supervisor-test", token, |token| {
                while !token.is_cancelled() {
                    std::thread::sleep(Duration::from_millis(5));
                }
            })
            .unwrap();

        assert_eq!(supervisor.current(), 1);
        assert!(supervisor.shutdown(Duration::from_secs(1)).await);
        handle.join().unwrap();
        assert_eq!(supervisor.current(), 0);
    }

    #[test]
    fn join_blocking_jobs_counts_finished_workers() {
        let jobs = vec![1, 2, 3];
        let done = TaskSupervisor::join_blocking_jobs(
            "task-supervisor-join-test",
            jobs,
            Duration::from_secs(1),
            |_| {},
        );
        assert_eq!(done, 3);
    }
}

// アプリ全体の共有 state

use crate::pty::{InFlightTracker, SessionRegistry};
use crate::team_hub::TeamHub;
use std::sync::{Arc, Mutex, MutexGuard};

pub struct AppState {
    /// 現在 UI で開いているプロジェクトルート。
    ///
    /// Issue #56 / #147 注記:
    ///   `std::sync::Mutex` を async コンテキスト (tokio task) から `.lock()` するのは
    ///   通常アンチパターンだが、ここは `lock → clone → unlock` のみで重い処理は入れない。
    ///   クリティカル区間を絶対に短く保つこと (canonicalize / fs I/O を lock 保持中に
    ///   行ってはいけない)。lock 保持中に `.await` は絶対禁止。
    ///   poison が発生しても `lock_project_root_recover` 経由で recovery できる。
    pub project_root: Mutex<Option<String>>,
    pub pty_registry: Arc<SessionRegistry>,
    pub team_hub: TeamHub,
    /// Issue #630: 進行中の PTY inject task (codex 初期 prompt 注入 / team_send 経由 inject /
    /// retry inject) の件数を追跡する tracker。CloseRequested handler が `wait_idle(timeout)`
    /// を await して in-flight task の自然完了を待ってから kill_all() を呼ぶため、SessionHandle
    /// の Mutex poison / 半端 inject による不正出力 / reader thread 解放漏れの race を防ぐ。
    pub pty_inflight: Arc<InFlightTracker>,
}

/// Issue #147: project_root の Mutex が poison しても、内部値は単純な Option<String> なので
/// safe に取り出せる。poison_error.into_inner() で guard を取り出して使い続ける。
/// 上位呼び出し側はこのヘルパを使うことで以降の root 切替が永続失敗する状態を避けられる。
pub fn lock_project_root_recover<'a>(
    m: &'a Mutex<Option<String>>,
) -> MutexGuard<'a, Option<String>> {
    match m.lock() {
        Ok(g) => g,
        Err(poisoned) => {
            tracing::warn!("[state] project_root mutex poisoned — recovering");
            poisoned.into_inner()
        }
    }
}


impl AppState {
    pub fn new() -> Self {
        let pty_registry = Arc::new(SessionRegistry::new());
        let pty_inflight = InFlightTracker::new();
        // Issue #630: TeamHub と AppState で同じ tracker Arc を共有することで、
        // `team_send` 経由の inject::inject も `terminal_create` 経由の codex 注入も
        // 同一 counter で wait_idle できる。
        let team_hub = TeamHub::with_inflight(pty_registry.clone(), pty_inflight.clone());
        Self {
            project_root: Mutex::new(None),
            pty_registry,
            team_hub,
            pty_inflight,
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

// アプリ全体の共有 state

use crate::pty::{InFlightTracker, SessionRegistry};
use crate::team_hub::TeamHub;
use arc_swap::ArcSwapOption;
use std::sync::Arc;

pub struct AppState {
    /// 現在 UI で開いているプロジェクトルート。
    ///
    /// Issue #56 / #147 / #739 注記:
    ///   旧実装は `std::sync::Mutex<Option<String>>` で、`lock → clone → unlock` のみとはいえ
    ///   async コンテキスト (tokio task) から `.lock()` するアンチパターンを抱えていた。
    ///   `arc_swap::ArcSwapOption<String>` に置換したことで lock 自体が存在しなくなり、
    ///   load / store はいずれも lock-free atomic な操作になる。これにより
    ///   「async task から lock を保持したまま `.await`」という deadlock 経路が
    ///   **構造的に発生しえない** 状態になった。poison 概念も無くなる。
    ///   読み出しは `current_project_root`、書き込みは `set_project_root` ヘルパを使う。
    pub project_root: ArcSwapOption<String>,
    pub pty_registry: Arc<SessionRegistry>,
    pub team_hub: TeamHub,
    /// Issue #630: 進行中の PTY inject task (codex 初期 prompt 注入 / team_send 経由 inject /
    /// retry inject) の件数を追跡する tracker。CloseRequested handler が `wait_idle(timeout)`
    /// を await して in-flight task の自然完了を待ってから kill_all() を呼ぶため、SessionHandle
    /// の Mutex poison / 半端 inject による不正出力 / reader thread 解放漏れの race を防ぐ。
    pub pty_inflight: Arc<InFlightTracker>,
}

/// Issue #739: `ArcSwapOption<String>` から現在の project_root を `Option<String>` として
/// 取り出す。lock-free な atomic load なので async コンテキストから呼んでも安全。
///
/// 旧 `lock_project_root_recover` (poison recovery 付き `MutexGuard` 返却) の後継。
/// 呼び出し側が `MutexGuard` ではなく値そのものを欲しがるパターン (`.clone()` /
/// `.unwrap_or_default()`) しか存在しなかったため、値を直接返す形に簡素化している。
pub fn current_project_root(slot: &ArcSwapOption<String>) -> Option<String> {
    slot.load().as_deref().map(|s| s.clone())
}

/// Issue #739: project_root を更新する。`Some("")` のような空文字はそのまま保持する
/// (空判定 / trim は呼び出し側の責務 — 旧 Mutex 実装と同じセマンティクス)。
pub fn set_project_root(slot: &ArcSwapOption<String>, value: Option<String>) {
    slot.store(value.map(Arc::new));
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
            project_root: ArcSwapOption::from(None),
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

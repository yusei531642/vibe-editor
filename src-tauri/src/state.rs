// アプリ全体の共有 state

use crate::commands::project_authority::ProjectRootIdentity;
use crate::pty::{InFlightTracker, SessionRegistry};
use crate::task_supervisor::TaskSupervisor;
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
    /// Issue #1193: active rootのnative approval時filesystem identity。path文字列だけの
    /// `project_root` と常に対で更新し、strict authzがdirectory置換をfail-closedに検出する。
    pub project_root_identity: ArcSwapOption<ProjectRootIdentity>,
    pub pty_registry: Arc<SessionRegistry>,
    pub team_hub: TeamHub,
    /// Issue #952: watcher / cleanup / poller / inject 系 background task の共通 supervisor。
    /// shutdown 時はここで cancel token を立て、bounded wait してから PTY process-tree kill に進む。
    pub task_supervisor: Arc<TaskSupervisor>,
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
    slot.load().as_deref().cloned()
}

/// active rootのpathとidentityを一体で更新する。読取側はidentityを再検証してから副作用へ進む。
pub fn set_project_root_authority(
    root_slot: &ArcSwapOption<String>,
    identity_slot: &ArcSwapOption<ProjectRootIdentity>,
    identity: Option<ProjectRootIdentity>,
) {
    let root = identity
        .as_ref()
        .map(|identity| identity.canonical_root.clone());
    // identityを先にclear/storeしても、root readerは後段のauthzで両方を照合するためfail-closed。
    identity_slot.store(identity.map(Arc::new));
    root_slot.store(root.map(Arc::new));
    // 旧rootで成立した再照合キャッシュを新authorityへ持ち越さない。
    crate::commands::authz::invalidate_identity_recheck();
}

/// active rootに対応するnative approval snapshotをlock-freeに取得する。
pub fn current_project_root_identity(
    slot: &ArcSwapOption<ProjectRootIdentity>,
) -> Option<ProjectRootIdentity> {
    slot.load().as_deref().cloned()
}

impl AppState {
    pub fn new() -> Self {
        let pty_registry = Arc::new(SessionRegistry::new());
        let task_supervisor = TaskSupervisor::new();
        let pty_inflight: Arc<InFlightTracker> = task_supervisor.clone();
        // Issue #630: TeamHub と AppState で同じ tracker Arc を共有することで、
        // `team_send` 経由の inject::inject も `terminal_create` 経由の codex 注入も
        // 同一 counter で wait_idle できる。
        let team_hub = TeamHub::with_inflight(pty_registry.clone(), pty_inflight.clone());
        Self {
            project_root: ArcSwapOption::from(None),
            project_root_identity: ArcSwapOption::from(None),
            pty_registry,
            team_hub,
            task_supervisor,
            pty_inflight,
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

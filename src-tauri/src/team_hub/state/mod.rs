//! `team_hub::state` — TeamHub の in-memory 状態 (`HubState`) と `TeamHub` の impl 群。
//!
//! Issue #736: 旧 `state.rs` (2000+ 行の god-file) を責務ごとのサブモジュールへ分割。
//! `TeamHub` への impl ブロックは Rust の同一クレート規則に従い複数モジュールへ分散する
//! (型・フィールドの可視性は変えていない純粋なリファクタ)。
//!
//! - [`hub_state`] — `HubState` struct と field 群、各種 in-memory データ型
//!   (`TeamInfo` / `TeamMessage` / `TeamTask` / `EnginePolicy` / `CallContext` 等)、
//!   コンストラクタ、サーバーライフサイクル (`start` / `info` / `set_app_handle`)。
//! - [`recruit`] — recruit / pending recruit / handshake grant / ack / semaphore 関連の
//!   型と impl (TTL / single-use / agent_id binding は Issue #742 由来)。
//! - [`member_diagnostics`] — `MemberDiagnostics` struct と診断 timestamp / counter の計算 impl。
//! - [`file_locks_glue`] — `file_locks` / dynamic role / engine policy / role profile summary
//!   の HubState 越し操作 impl。
//! - [`persistence`] — チーム登録 (`register_team`) / 破棄 (`clear_team`) / orchestration state
//!   の永続化 (`persist_team_state` / `record_handoff_lifecycle`) と動的ロール復元。

mod file_locks_glue;
mod hub_state;
mod member_diagnostics;
mod persistence;
mod recruit;

// 旧 `state.rs` が公開していた型を `state` の表層に再エクスポートし、外部
// (`team_hub::mod.rs` の `pub use state::{...}` や `crate::team_hub::state::HubState`
// 経由の参照) から見たパスを変えない。
//
// `HubState` は `pub(crate)` のため `pub(crate) use` で再エクスポートする
// (旧 `state.rs` でも `pub(crate) struct HubState` だった)。
pub(crate) use hub_state::HubState;
pub use hub_state::{
    server_log_path_for_diagnostics, set_server_log_path, CallContext, DynamicRole, EnginePolicy,
    EnginePolicyKind, RoleProfileSummary, TeamInfo, TeamMessage, TeamTask,
};
pub use member_diagnostics::MemberDiagnostics;
// `RecruitAckOutcome` は `team_hub::mod.rs` が再エクスポートするので `state` 層でも公開する。
// 他の recruit 型 (`PendingRecruit` 等) は `state` 内部 + test でしか使わないので
// `recruit` モジュールに留め、ここでは re-export しない (= 旧 `state.rs` でも外部 caller なし)。
pub use recruit::RecruitAckOutcome;

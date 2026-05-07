//! `team_hub::protocol::tools` — MCP `tools/call` で dispatch される各 tool の実装。
//!
//! Issue #373 Phase 2 で `protocol.rs` から 11 個の tool 関数を切り出し。
//! Issue #493: 各 tool が共通で使う構造化エラー型を `error` モジュールに集約。
//! 各 tool は `pub(super) async fn team_xxx(...)` で公開され、
//! 親 `protocol/mod.rs` の `dispatch_tool` から呼び出される。

mod ack_handoff;
mod assign_task;
mod create_leader;
mod diagnostics;
mod dismiss;
pub(super) mod error;
mod get_tasks;
mod info;
mod list_role_profiles;
mod read;
mod recruit;
mod send;
mod status;
mod switch_leader;
mod update_task;

pub use ack_handoff::team_ack_handoff;
pub use assign_task::team_assign_task;
pub use create_leader::team_create_leader;
pub use diagnostics::team_diagnostics;
pub use dismiss::team_dismiss;
pub use get_tasks::team_get_tasks;
pub use info::team_info;
pub use list_role_profiles::team_list_role_profiles;
pub use read::team_read;
pub use recruit::team_recruit;
pub use send::team_send;
pub use status::team_status;
pub use switch_leader::team_switch_leader;
pub use update_task::team_update_task;

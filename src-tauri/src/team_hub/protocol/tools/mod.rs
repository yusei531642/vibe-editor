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
// Issue #526: vibe-team の advisory file lock (team_lock_files / team_unlock_files)。
mod file_lock;
mod get_tasks;
mod info;
mod list_role_profiles;
mod read;
mod recruit;
// Issue #572: worker → Leader の構造化完了/中断報告。
mod report;
mod send;
mod status;
mod switch_leader;
mod update_task;

pub use ack_handoff::team_ack_handoff;
pub use assign_task::team_assign_task;
pub use create_leader::team_create_leader;
pub use diagnostics::team_diagnostics;
pub use dismiss::team_dismiss;
pub use file_lock::{team_lock_files, team_unlock_files};
pub use get_tasks::team_get_tasks;
pub use info::team_info;
pub use list_role_profiles::team_list_role_profiles;
pub use read::team_read;
pub use recruit::team_recruit;
pub use report::team_report;
pub use send::team_send;
pub use status::team_status;
pub use switch_leader::team_switch_leader;
pub use update_task::team_update_task;

/// Issue #1004: API エージェント (socket を持たない pull 型 virtual member) が tool として
/// team 系操作を実行するための単一 dispatch シーム。read / send / info の 3 つだけを公開し、
/// 各 tool の異なるエラー型 (`ToolError` / `SendError`) を文字列に正規化してツール結果として
/// 返す。dispatch / inject などの中核ルーティングには一切触れない。
pub(crate) async fn call_api_agent_tool(
    hub: &crate::team_hub::TeamHub,
    ctx: &crate::team_hub::CallContext,
    name: &str,
    args: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    match name {
        "team_read" => read::team_read(hub, ctx, args)
            .await
            .map_err(|e| e.to_string()),
        "team_send" => send::team_send(hub, ctx, args)
            .await
            .map_err(|e| format!("{e:?}")),
        "team_info" => info::team_info(hub, ctx).await.map_err(|e| e.to_string()),
        other => Err(format!("unknown team tool: {other}")),
    }
}

//! tool: `team_diagnostics` — per-member diagnostic timestamps and counters.
//!
//! Issue #342 Phase 3 (3.4): leader/hr のみアクセス可。一般ワーカーは
//! permission denied で弾く (server_log_path 漏えい防止)。
//!
//! Issue #373 Phase 2 で `protocol.rs` から切り出し。

use crate::team_hub::{CallContext, MemberDiagnostics, TeamHub};
use serde_json::{json, Value};
use std::collections::HashMap;

use super::super::permissions::caller_has_permission;

/// Issue #342 Phase 3 (3.4): `team_diagnostics` MCP ツール。
///
/// 認可: `canViewDiagnostics` (= leader / hr のみ true)。一般ワーカーは
/// `permission denied` で弾く (server_log_path 漏えい防止)。
///
/// 戻り値スキーマ:
/// ```json
/// {
///   "myAgentId": "...", "myRole": "leader", "teamId": "...",
///   "serverLogPath": "~/.vibe-editor/logs/vibe-editor.log" or "<stderr>",
///   "members": [{ agentId, role, online, inconsistent, recruitedAt,
///                 lastHandshakeAt, lastSeenAt, lastMessageInAt, lastMessageOutAt,
///                 messagesInCount, messagesOutCount, tasksClaimedCount,
///                 currentStatus, lastStatusAt }]
/// }
/// ```
///
/// `team_info` の `inconsistent` 判定と同じロジックを共有する (handshake で bind した
/// role と registry の role が乖離していたら true、bind 未登録は false)。
pub async fn team_diagnostics(hub: &TeamHub, ctx: &CallContext) -> Result<Value, String> {
    if !caller_has_permission(hub, &ctx.role, "canViewDiagnostics").await {
        return Err(format!(
            "permission denied: role '{}' cannot view diagnostics",
            ctx.role
        ));
    }
    let bindings_snapshot: HashMap<String, String>;
    let diag_snapshot: HashMap<String, MemberDiagnostics>;
    {
        let state = hub.state.lock().await;
        bindings_snapshot = state.agent_role_bindings.clone();
        diag_snapshot = state.member_diagnostics.clone();
    }
    let members: Vec<_> = hub
        .registry
        .list_team_members(&ctx.team_id)
        .into_iter()
        .map(|(aid, role)| {
            let inconsistent = match bindings_snapshot.get(&aid) {
                Some(bound) => !bound.eq_ignore_ascii_case(&role),
                None => false,
            };
            let d = diag_snapshot.get(&aid).cloned().unwrap_or_default();
            json!({
                "agentId": aid,
                "role": role,
                "online": true,
                "inconsistent": inconsistent,
                "recruitedAt": d.recruited_at,
                "lastHandshakeAt": d.last_handshake_at,
                "lastSeenAt": d.last_seen_at,
                "lastMessageInAt": d.last_message_in_at,
                "lastMessageOutAt": d.last_message_out_at,
                "messagesInCount": d.messages_in_count,
                "messagesOutCount": d.messages_out_count,
                "tasksClaimedCount": d.tasks_claimed_count,
                // Issue #409: 自己申告ステータス。team_status を呼んでいなければ null。
                "currentStatus": d.current_status,
                "lastStatusAt": d.last_status_at,
            })
        })
        .collect();
    Ok(json!({
        "myAgentId": ctx.agent_id,
        "myRole": ctx.role,
        "teamId": ctx.team_id,
        "serverLogPath": crate::team_hub::server_log_path_for_diagnostics(),
        "members": members,
    }))
}

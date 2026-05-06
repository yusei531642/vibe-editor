//! tool: `team_switch_leader` — Issue #423: 引き継ぎ用に新 leader へ active 切替 + 旧 leader retire。
//!
//! 想定フロー (旧 leader が呼ぶ):
//!   1. `team_create_leader` で新 leader を spawn
//!   2. 新 leader が handoff document を読み終えて返事を返した
//!   3. 旧 leader が `team_switch_leader(new_leader_agent_id)` を呼ぶ
//!   4. Hub は active leader を切替え、旧 leader カードを retire させる
//!
//! 旧 leader カードを「即座に閉じる」と MCP 応答が PTY に届く前に terminal が殺され、
//! Claude/Codex の最終発話が消える。安全のため emit を **2 秒遅延** させて応答配送猶予を確保する。

use crate::team_hub::error::ToolError;
use crate::team_hub::{CallContext, TeamHub};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::Emitter;

use super::super::permissions::caller_has_permission;

pub async fn team_switch_leader(
    hub: &TeamHub,
    ctx: &CallContext,
    args: &Value,
) -> Result<Value, String> {
    if !caller_has_permission(hub, &ctx.role, "canRecruit").await {
        return Err(ToolError {
            code: "switch_leader_permission_denied".into(),
            message: format!(
                "permission denied: role '{}' cannot switch leader",
                ctx.role
            ),
            phase: None,
            elapsed_ms: None,
        }
        .into_err_string());
    }

    let new_leader_agent_id = args
        .get("new_leader_agent_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if new_leader_agent_id.is_empty() {
        return Err(ToolError {
            code: "switch_leader_invalid_args".into(),
            message: "new_leader_agent_id is required".into(),
            phase: None,
            elapsed_ms: None,
        }
        .into_err_string());
    }
    if new_leader_agent_id == ctx.agent_id {
        return Err(ToolError {
            code: "switch_leader_same_agent".into(),
            message: "new_leader_agent_id must differ from the caller".into(),
            phase: None,
            elapsed_ms: None,
        }
        .into_err_string());
    }

    let close_old_card = args
        .get("close_old_card")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let handoff_id = args
        .get("handoff_id")
        .or_else(|| args.get("handoffId"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToOwned::to_owned);

    // 新 leader が同チームに居て role が leader か確認
    let members = hub.registry.list_team_members(&ctx.team_id);
    let new_leader_entry = members
        .iter()
        .find(|(aid, _)| aid == &new_leader_agent_id)
        .cloned();
    let Some((_, new_role)) = new_leader_entry else {
        return Err(ToolError {
            code: "switch_leader_not_found".into(),
            message: format!(
                "new_leader_agent_id '{new_leader_agent_id}' is not in this team (call team_create_leader first and wait for handshake)"
            ),
            phase: None,
            elapsed_ms: None,
        }
        .into_err_string());
    };
    if new_role != "leader" {
        return Err(ToolError {
            code: "switch_leader_role_mismatch".into(),
            message: format!(
                "new_leader_agent_id '{new_leader_agent_id}' is registered as role '{new_role}', not 'leader'"
            ),
            phase: None,
            elapsed_ms: None,
        }
        .into_err_string());
    }

    // active leader を切替え
    hub.set_active_leader(&ctx.team_id, Some(new_leader_agent_id.clone()))
        .await;
    if let Some(handoff_id) = &handoff_id {
        if let Err(e) = hub
            .record_handoff_lifecycle(
                &ctx.team_id,
                handoff_id,
                "retired",
                Some(new_leader_agent_id.clone()),
                Some(format!("old leader {} retired", ctx.agent_id)),
            )
            .await
        {
            tracing::warn!("[team_switch_leader] handoff lifecycle update failed: {e}");
        }
    }

    // 旧 leader カードの retire を予約 (2 秒遅延で MCP 応答配送猶予を確保)
    if close_old_card {
        let app_handle_lock = hub.app_handle.lock().await.clone();
        let team_id = ctx.team_id.clone();
        let old_agent_id = ctx.agent_id.clone();
        if let Some(app_handle) = app_handle_lock {
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(2)).await;
                if let Err(e) = app_handle.emit(
                    "team:dismiss-request",
                    json!({ "teamId": team_id, "agentId": old_agent_id }),
                ) {
                    tracing::warn!("emit team:dismiss-request (switch_leader) failed: {e}");
                }
            });
        }
    }

    Ok(json!({
        "success": true,
        "newLeaderAgentId": new_leader_agent_id,
        "oldLeaderAgentId": ctx.agent_id,
        "oldCardCloseScheduledMs": if close_old_card { 2000 } else { 0 },
        "handoffId": handoff_id,
    }))
}

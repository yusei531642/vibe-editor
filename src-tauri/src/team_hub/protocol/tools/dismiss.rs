//! tool: `team_dismiss` — remove a member from the canvas.
//!
//! Issue #373 Phase 2 で `protocol.rs` から切り出し。

use crate::team_hub::error::DismissError;
use crate::team_hub::{CallContext, TeamHub};
use chrono::Utc;
use serde_json::{json, Value};
use tauri::Emitter;

use super::super::permissions::caller_has_permission;

pub async fn team_dismiss(
    hub: &TeamHub,
    ctx: &CallContext,
    args: &Value,
) -> Result<Value, String> {
    if !caller_has_permission(hub, &ctx.role, "canDismiss").await {
        return Err(DismissError {
            code: "dismiss_permission_denied".into(),
            message: format!("permission denied: role '{}' cannot dismiss", ctx.role),
            phase: None,
            elapsed_ms: None,
        }
        .into_err_string());
    }
    let agent_id = args
        .get("agent_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if agent_id.is_empty() {
        return Err(DismissError {
            code: "dismiss_invalid_args".into(),
            message: "agent_id is required".into(),
            phase: None,
            elapsed_ms: None,
        }
        .into_err_string());
    }
    if agent_id == ctx.agent_id {
        return Err(DismissError {
            code: "dismiss_self".into(),
            message: "cannot dismiss yourself".into(),
            phase: None,
            elapsed_ms: None,
        }
        .into_err_string());
    }
    // チーム所属チェック
    let members = hub.registry.list_team_members(&ctx.team_id);
    if !members.iter().any(|(aid, _)| aid == &agent_id) {
        return Err(DismissError {
            code: "dismiss_not_found".into(),
            message: format!("agent '{agent_id}' is not in this team"),
            phase: None,
            elapsed_ms: None,
        }
        .into_err_string());
    }
    // Issue #342 Phase 3 (3.6): dismiss 直前に被 dismiss 側の last_seen_at / 既存 recruited_at を
    // スナップしておき、戻り値に `lastSeenAt` を載せる (= 最後の生存時刻)。
    let last_seen_at = hub
        .get_member_diagnostics(&agent_id)
        .await
        .and_then(|d| d.last_seen_at);
    // Renderer に閉じてもらう
    let app = hub.app_handle.lock().await.clone();
    if let Some(app) = &app {
        let _ = app.emit(
            "team:dismiss-request",
            json!({ "teamId": ctx.team_id, "agentId": agent_id }),
        );
    }
    // Issue #342 Phase 2: dismiss 時に pending_recruits の同 agent_id エントリも掃除する。
    // 旧実装は emit のみで Hub 状態を直接触らなかったため、handshake 完了前に
    // dismiss された pending が孤立し、try_register_pending_recruit の人数 / singleton
    // 判定にゴミとして残り続けていた (renderer 反映の冪等性が壊れる)。
    hub.cancel_pending_recruit(&agent_id).await;
    let dismissed_at = Utc::now().to_rfc3339();
    Ok(json!({
        "success": true,
        "agentId": agent_id,
        "dismissedAt": dismissed_at,
        "lastSeenAt": last_seen_at,
    }))
}

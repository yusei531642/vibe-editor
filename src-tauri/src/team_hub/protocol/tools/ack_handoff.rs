//! tool: `team_ack_handoff` — mark a handoff as read/acked by the replacement leader.

use crate::team_hub::{CallContext, TeamHub};
use serde_json::{json, Value};

use super::super::permissions::{check_permission, Permission};
use super::error::ToolError;

pub async fn team_ack_handoff(
    hub: &TeamHub,
    ctx: &CallContext,
    args: &Value,
) -> Result<Value, String> {
    if let Err(e) = check_permission(&ctx.role, Permission::Recruit) {
        return Err(
            ToolError::permission_denied("ack_handoff", &e.role, "ack handoff").into_err_string(),
        );
    }

    let handoff_id = args
        .get("handoff_id")
        .or_else(|| args.get("handoffId"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "handoff_id is required".to_string())?;
    let note = args
        .get("note")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToOwned::to_owned);

    hub.record_handoff_lifecycle(
        &ctx.team_id,
        handoff_id,
        "acked",
        Some(ctx.agent_id.clone()),
        note,
    )
    .await?;

    Ok(json!({
        "success": true,
        "handoffId": handoff_id,
        "ackedByAgentId": ctx.agent_id,
    }))
}

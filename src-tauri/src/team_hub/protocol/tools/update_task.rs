//! tool: `team_update_task` — update the status of a task.
//!
//! Issue #373 Phase 2 で `protocol.rs` から切り出し。

use crate::team_hub::{CallContext, TeamHub};
use serde_json::{json, Value};

pub async fn team_update_task(
    hub: &TeamHub,
    ctx: &CallContext,
    args: &Value,
) -> Result<Value, String> {
    let task_id = args.get("task_id").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let status = args.get("status").and_then(|v| v.as_str()).unwrap_or("");
    let mut state = hub.state.lock().await;
    let team = state
        .teams
        .get_mut(&ctx.team_id)
        .ok_or_else(|| "Team not found".to_string())?;
    let task = team
        .tasks
        .iter_mut()
        .find(|t| t.id == task_id)
        .ok_or_else(|| format!("Task #{task_id} not found"))?;
    task.status = status.to_string();
    Ok(json!({ "success": true }))
}

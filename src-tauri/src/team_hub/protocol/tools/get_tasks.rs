//! tool: `team_get_tasks` — list all tasks in the team.
//!
//! Issue #373 Phase 2 で `protocol.rs` から切り出し。

use crate::team_hub::{CallContext, TeamHub};
use serde_json::{json, Value};

pub async fn team_get_tasks(hub: &TeamHub, ctx: &CallContext) -> Result<Value, String> {
    let state = hub.state.lock().await;
    let tasks = state
        .teams
        .get(&ctx.team_id)
        .map(|t| {
            t.tasks
                .iter()
                .map(|x| {
                    json!({
                        "id": x.id,
                        "assignedTo": x.assigned_to,
                        "description": x.description,
                        "status": x.status,
                        "createdBy": x.created_by,
                        "createdAt": x.created_at,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(json!({ "tasks": tasks }))
}

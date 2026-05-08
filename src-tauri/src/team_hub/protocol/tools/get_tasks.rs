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
                    let snapshot = x.to_snapshot();
                    json!({
                        "id": snapshot.id,
                        "assignedTo": snapshot.assigned_to,
                        "description": snapshot.description,
                        "status": snapshot.status,
                        "createdBy": snapshot.created_by,
                        "createdAt": snapshot.created_at,
                        "updatedAt": snapshot.updated_at,
                        "summary": snapshot.summary,
                        "blockedReason": snapshot.blocked_reason,
                        "nextAction": snapshot.next_action,
                        "artifactPath": snapshot.artifact_path,
                        "blockedByHumanGate": snapshot.blocked_by_human_gate,
                        "requiredHumanDecision": snapshot.required_human_decision,
                        "targetPaths": snapshot.target_paths,
                        "lockConflicts": snapshot.lock_conflicts,
                        "preApproval": snapshot.pre_approval,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(json!({ "tasks": tasks }))
}

//! tool: `team_update_task` — update the status of a task.
//!
//! Issue #373 Phase 2 で `protocol.rs` から切り出し。

use crate::team_hub::{CallContext, TeamHub};
use chrono::Utc;
use serde_json::{json, Value};

pub async fn team_update_task(
    hub: &TeamHub,
    ctx: &CallContext,
    args: &Value,
) -> Result<Value, String> {
    let task_id = args.get("task_id").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let status = args.get("status").and_then(|v| v.as_str()).unwrap_or("");
    let mut state = hub.state.lock().await;
    {
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
    }
    let now_iso = Utc::now().to_rfc3339();
    let diagnostics = state
        .member_diagnostics
        .entry(ctx.agent_id.clone())
        .or_default();
    diagnostics.last_seen_at = Some(now_iso);
    Ok(json!({ "success": true }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty::SessionRegistry;
    use crate::team_hub::{TeamHub, TeamInfo, TeamTask};
    use std::sync::Arc;

    #[tokio::test]
    async fn update_task_marks_caller_as_seen_activity() {
        let hub = TeamHub::new(Arc::new(SessionRegistry::new()));
        let team_id = "team-test".to_string();
        let worker_aid = "worker-1".to_string();
        {
            let mut state = hub.state.lock().await;
            let team = state
                .teams
                .entry(team_id.clone())
                .or_insert_with(TeamInfo::default);
            team.tasks.push_back(TeamTask {
                id: 3,
                assigned_to: "worker".into(),
                description: "continue".into(),
                status: "pending".into(),
                created_by: "leader".into(),
                created_at: "2026-05-04T10:00:00Z".into(),
            });
        }

        let ctx = CallContext {
            team_id,
            role: "worker".into(),
            agent_id: worker_aid.clone(),
        };

        team_update_task(
            &hub,
            &ctx,
            &json!({ "task_id": 3, "status": "in_progress" }),
        )
        .await
        .expect("team_update_task ok");

        let state = hub.state.lock().await;
        let diagnostics = state.member_diagnostics.get(&worker_aid).unwrap();
        assert!(diagnostics.last_seen_at.is_some());
    }
}

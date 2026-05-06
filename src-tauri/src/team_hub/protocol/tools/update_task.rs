//! tool: `team_update_task` — update the status of a task.
//!
//! Issue #373 Phase 2 で `protocol.rs` から切り出し。

use crate::team_hub::{CallContext, TeamHub};
use chrono::Utc;
use serde_json::{json, Value};

fn optional_string(args: &Value, snake: &str, camel: &str) -> Option<String> {
    args.get(snake)
        .or_else(|| args.get(camel))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToOwned::to_owned)
}

fn optional_bool(args: &Value, snake: &str, camel: &str) -> Option<bool> {
    args.get(snake)
        .or_else(|| args.get(camel))
        .and_then(|v| v.as_bool())
}

fn looks_like_human_gate(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("human")
        || lower.contains("approval")
        || lower.contains("approve")
        || text.contains("承認")
        || text.contains("人間")
        || text.contains("判断")
}

pub async fn team_update_task(
    hub: &TeamHub,
    ctx: &CallContext,
    args: &Value,
) -> Result<Value, String> {
    let task_id = args.get("task_id").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let status = args.get("status").and_then(|v| v.as_str()).unwrap_or("");
    let summary = optional_string(args, "summary", "summary");
    let blocked_reason = optional_string(args, "blocked_reason", "blockedReason");
    let next_action = optional_string(args, "next_action", "nextAction");
    let artifact_path = optional_string(args, "artifact_path", "artifactPath");
    let required_human_decision =
        optional_string(args, "required_human_decision", "requiredHumanDecision");
    let explicit_human_gate =
        optional_bool(args, "blocked_by_human_gate", "blockedByHumanGate").unwrap_or(false);
    let blocked_by_human_gate = explicit_human_gate
        || blocked_reason
            .as_deref()
            .map(looks_like_human_gate)
            .unwrap_or(false)
        || required_human_decision.is_some();
    let now_iso = Utc::now().to_rfc3339();
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
        task.updated_at = Some(now_iso.clone());
        if summary.is_some() {
            task.summary = summary.clone();
        }
        if blocked_reason.is_some() {
            task.blocked_reason = blocked_reason.clone();
        }
        if next_action.is_some() {
            task.next_action = next_action.clone();
        }
        if artifact_path.is_some() {
            task.artifact_path = artifact_path.clone();
        }
        if blocked_by_human_gate {
            task.blocked_by_human_gate = true;
            task.required_human_decision = required_human_decision.clone();
        }
        let task_summary = task.summary.clone();
        let task_blocked_reason = task.blocked_reason.clone();
        let task_next_action = task.next_action.clone();
        let task_artifact_path = task.artifact_path.clone();
        if blocked_by_human_gate {
            team.human_gate.blocked = true;
            team.human_gate.reason = blocked_reason.clone().or_else(|| summary.clone());
            team.human_gate.required_decision = required_human_decision.clone();
            team.human_gate.source = Some(format!("task:{task_id}"));
            team.human_gate.updated_at = Some(now_iso.clone());
        }
        if let Some(action) = &next_action {
            team.next_actions.push_back(action.clone());
            while team.next_actions.len() > 20 {
                let _ = team.next_actions.pop_front();
            }
        }
        let status_lower = status.to_ascii_lowercase();
        if matches!(
            status_lower.as_str(),
            "done" | "completed" | "complete" | "blocked"
        ) {
            let kind = optional_string(args, "report_kind", "reportKind")
                .unwrap_or_else(|| status_lower.clone());
            let report_summary = summary
                .clone()
                .or_else(|| task_summary.clone())
                .unwrap_or_else(|| format!("Task #{task_id} marked {status}"));
            team.worker_reports
                .push_back(crate::commands::team_state::WorkerReportSnapshot {
                    id: format!("task-{task_id}-{}", now_iso.replace([':', '.'], "-")),
                    task_id: Some(task_id),
                    from_role: ctx.role.clone(),
                    from_agent_id: ctx.agent_id.clone(),
                    kind,
                    summary: report_summary,
                    blocked_reason: blocked_reason.clone().or(task_blocked_reason),
                    next_action: next_action.clone().or(task_next_action),
                    artifact_path: artifact_path.clone().or(task_artifact_path),
                    created_at: now_iso.clone(),
                });
            while team.worker_reports.len() > 50 {
                let _ = team.worker_reports.pop_front();
            }
        }
    }
    let diagnostics = state
        .member_diagnostics
        .entry(ctx.agent_id.clone())
        .or_default();
    diagnostics.last_seen_at = Some(now_iso);
    drop(state);
    if let Err(e) = hub.persist_team_state(&ctx.team_id).await {
        tracing::warn!("[team_update_task] persist team-state failed: {e}");
    }
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
                updated_at: None,
                summary: None,
                blocked_reason: None,
                next_action: None,
                artifact_path: None,
                blocked_by_human_gate: false,
                required_human_decision: None,
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

    #[tokio::test]
    async fn update_task_records_structured_report_and_human_gate() {
        let hub = TeamHub::new(Arc::new(SessionRegistry::new()));
        let team_id = "team-report".to_string();
        {
            let mut state = hub.state.lock().await;
            let team = state
                .teams
                .entry(team_id.clone())
                .or_insert_with(TeamInfo::default);
            team.tasks.push_back(TeamTask {
                id: 7,
                assigned_to: "worker".into(),
                description: "release gate".into(),
                status: "pending".into(),
                created_by: "leader".into(),
                created_at: "2026-05-04T10:00:00Z".into(),
                updated_at: None,
                summary: None,
                blocked_reason: None,
                next_action: None,
                artifact_path: None,
                blocked_by_human_gate: false,
                required_human_decision: None,
            });
        }

        let ctx = CallContext {
            team_id: team_id.clone(),
            role: "worker".into(),
            agent_id: "worker-7".into(),
        };

        team_update_task(
            &hub,
            &ctx,
            &json!({
                "task_id": 7,
                "status": "blocked",
                "summary": "QA approval is required",
                "blocked_by_human_gate": true,
                "required_human_decision": "QA approve / reject",
                "next_action": "Wait for QA"
            }),
        )
        .await
        .expect("team_update_task ok");

        let state = hub.state.lock().await;
        let team = state.teams.get(&team_id).unwrap();
        assert_eq!(team.worker_reports.len(), 1);
        assert!(team.human_gate.blocked);
        assert_eq!(
            team.human_gate.required_decision.as_deref(),
            Some("QA approve / reject")
        );
        assert_eq!(
            team.next_actions.back().map(String::as_str),
            Some("Wait for QA")
        );
    }
}

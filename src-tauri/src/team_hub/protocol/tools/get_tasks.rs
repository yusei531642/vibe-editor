//! tool: `team_get_tasks` — list all tasks in the team.
//!
//! Issue #373 Phase 2 で `protocol.rs` から切り出し。
//! Issue #572: `team_report` 由来の構造化レポートを各 task に紐付けて返す。

use crate::team_hub::{CallContext, TeamHub};
use serde_json::{json, Value};

pub async fn team_get_tasks(hub: &TeamHub, ctx: &CallContext) -> Result<Value, String> {
    let state = hub.state.lock().await;
    let team = match state.teams.get(&ctx.team_id) {
        Some(t) => t,
        None => return Ok(json!({ "tasks": [], "teamReports": [] })),
    };

    // Issue #572: task_id_num が一致するレポートを各 task に attach する。Hub の
    // `team_reports` backlog 全体は別フィールド `teamReports` でも返して、未紐付け
    // (= task_id_num=None / 外部 planner id 等) のレポートも Leader が読める。
    let tasks = team
        .tasks
        .iter()
        .map(|x| {
            let snapshot = x.to_snapshot();
            let task_reports: Vec<Value> = team
                .team_reports
                .iter()
                .filter(|r| r.task_id_num == Some(snapshot.id))
                .map(|r| serde_json::to_value(r).unwrap_or(Value::Null))
                .collect();
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
                "doneCriteria": snapshot.done_criteria,
                "doneEvidence": snapshot.done_evidence,
                // Issue #572: この task に紐付いた team_report レポート群 (古い順)。
                // additive フィールドなので外部 client は無視できる。
                "reports": task_reports,
            })
        })
        .collect::<Vec<_>>();

    let team_reports: Vec<Value> = team
        .team_reports
        .iter()
        .map(|r| serde_json::to_value(r).unwrap_or(Value::Null))
        .collect();

    Ok(json!({
        "tasks": tasks,
        // Issue #572: backlog 全体 (task に紐付かないものも含む)。
        "teamReports": team_reports,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::team_state::{TeamReportFinding, TeamReportSnapshot};
    use crate::pty::SessionRegistry;
    use crate::team_hub::{TeamHub, TeamInfo, TeamTask};
    use std::sync::Arc;

    /// Issue #572: task_id_num が task.id と一致するレポートが `tasks[].reports[]` に乗ること、
    /// task_id_num が None のレポートは task に attach されず `teamReports` (backlog) だけに残ること。
    #[tokio::test]
    async fn returns_team_reports_attached_to_tasks() {
        let hub = TeamHub::new(Arc::new(SessionRegistry::new()));
        let team_id = "team-572-get-tasks".to_string();
        {
            let mut state = hub.state.lock().await;
            let team = state
                .teams
                .entry(team_id.clone())
                .or_insert_with(TeamInfo::default);
            team.tasks.push_back(TeamTask {
                id: 100,
                assigned_to: "programmer".into(),
                description: "ship feature".into(),
                status: "in_progress".into(),
                created_by: "leader".into(),
                created_at: "2026-05-08T10:00:00Z".into(),
                updated_at: None,
                summary: None,
                blocked_reason: None,
                next_action: None,
                artifact_path: None,
                blocked_by_human_gate: false,
                required_human_decision: None,
                target_paths: Vec::new(),
                lock_conflicts: Vec::new(),
                pre_approval: None,
                done_criteria: Vec::new(),
                done_evidence: Vec::new(),
            });
            // 同 task に紐付くレポート 1 件
            team.team_reports.push_back(TeamReportSnapshot {
                id: "report-100-1".into(),
                task_id: "100".into(),
                task_id_num: Some(100),
                from_role: "programmer".into(),
                from_agent_id: "vc-prog".into(),
                status: "done".into(),
                summary: "shipped".into(),
                findings: vec![TeamReportFinding {
                    severity: "low".into(),
                    file: "".into(),
                    message: "minor cleanup".into(),
                }],
                changed_files: Vec::new(),
                artifact_refs: Vec::new(),
                next_actions: Vec::new(),
                created_at: "2026-05-08T10:30:00Z".into(),
            });
            // 紐付かない外部 planner レポート 1 件 (task_id_num=None)
            team.team_reports.push_back(TeamReportSnapshot {
                id: "report-PLAN-1".into(),
                task_id: "PLAN-001".into(),
                task_id_num: None,
                from_role: "researcher".into(),
                from_agent_id: "vc-r".into(),
                status: "needs_input".into(),
                summary: "external planner item".into(),
                findings: Vec::new(),
                changed_files: Vec::new(),
                artifact_refs: Vec::new(),
                next_actions: Vec::new(),
                created_at: "2026-05-08T10:35:00Z".into(),
            });
        }

        let ctx = CallContext {
            team_id: team_id.clone(),
            role: "leader".into(),
            agent_id: "vc-leader".into(),
        };
        let result = team_get_tasks(&hub, &ctx).await.unwrap();
        let tasks = result["tasks"].as_array().unwrap();
        assert_eq!(tasks.len(), 1);
        let task = &tasks[0];
        let reports = task["reports"].as_array().unwrap();
        assert_eq!(reports.len(), 1, "task 100 should attach 1 matching report");
        assert_eq!(reports[0]["taskIdNum"], 100);
        assert_eq!(reports[0]["status"], "done");

        let backlog = result["teamReports"].as_array().unwrap();
        assert_eq!(backlog.len(), 2, "backlog should include both reports");
    }

    #[tokio::test]
    async fn missing_team_returns_empty_arrays() {
        let hub = TeamHub::new(Arc::new(SessionRegistry::new()));
        let ctx = CallContext {
            team_id: "team-572-missing".into(),
            role: "leader".into(),
            agent_id: "vc-leader".into(),
        };
        let result = team_get_tasks(&hub, &ctx).await.unwrap();
        assert_eq!(result["tasks"].as_array().unwrap().len(), 0);
        assert_eq!(result["teamReports"].as_array().unwrap().len(), 0);
    }
}

//! tool: `team_update_task` — update the status of a task.
//!
//! Issue #373 Phase 2 で `protocol.rs` から切り出し。

use crate::commands::team_state::TaskDoneEvidenceSnapshot;
use crate::team_hub::{CallContext, TeamHub};
use chrono::Utc;
use serde_json::{json, Value};

use super::error::ToolError;

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

fn normalize_criterion(s: &str) -> String {
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

fn is_done_status(status: &str) -> bool {
    matches!(
        status.trim().to_ascii_lowercase().as_str(),
        "done" | "completed" | "complete"
    )
}

fn done_evidence_invalid(message: impl Into<String>) -> String {
    json!({
        "code": "task_done_evidence_invalid",
        "message": message.into(),
    })
    .to_string()
}

fn done_evidence_missing(missing: Vec<String>) -> String {
    json!({
        "code": "task_done_evidence_missing",
        "message": "done_evidence must cover every done_criteria item before marking the task done",
        "missingCriteria": missing,
    })
    .to_string()
}

fn parse_done_evidence(args: &Value) -> Result<Vec<TaskDoneEvidenceSnapshot>, String> {
    let Some(raw) = args
        .get("done_evidence")
        .or_else(|| args.get("doneEvidence"))
    else {
        return Ok(Vec::new());
    };
    let arr = raw
        .as_array()
        .ok_or_else(|| done_evidence_invalid("done_evidence must be an array"))?;
    let mut out = Vec::new();
    for item in arr {
        let obj = item.as_object().ok_or_else(|| {
            done_evidence_invalid("done_evidence entries must be objects with criterion/evidence")
        })?;
        let criterion = obj
            .get("criterion")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .ok_or_else(|| done_evidence_invalid("done_evidence.criterion is required"))?;
        let evidence = obj
            .get("evidence")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .ok_or_else(|| done_evidence_invalid("done_evidence.evidence is required"))?;
        out.push(TaskDoneEvidenceSnapshot {
            criterion: criterion.to_string(),
            evidence: evidence.to_string(),
        });
    }
    Ok(out)
}

/// Issue #516: `report_payload` をネスト JSON / フラット object どちらでも受けてパースする。
fn optional_report_payload(
    args: &Value,
) -> Option<crate::commands::team_state::WorkerReportPayload> {
    let payload = args
        .get("report_payload")
        .or_else(|| args.get("reportPayload"))?;
    if !payload.is_object() {
        return None;
    }
    let pick_string = |snake: &str, camel: &str| -> Option<String> {
        payload
            .get(snake)
            .or_else(|| payload.get(camel))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(ToOwned::to_owned)
    };
    let pick_string_array = |key: &str| -> Vec<String> {
        payload
            .get(key)
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(ToOwned::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };
    let findings = pick_string("findings", "findings");
    let proposal = pick_string("proposal", "proposal");
    let next_action = pick_string("next_action", "nextAction");
    let risks = pick_string_array("risks");
    let artifacts = pick_string_array("artifacts");
    let all_empty = findings.is_none()
        && proposal.is_none()
        && next_action.is_none()
        && risks.is_empty()
        && artifacts.is_empty();
    if all_empty {
        return None;
    }
    Some(crate::commands::team_state::WorkerReportPayload {
        findings,
        proposal,
        risks,
        next_action,
        artifacts,
    })
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
    let done_evidence = parse_done_evidence(args)?;
    let summary = optional_string(args, "summary", "summary");
    let blocked_reason = optional_string(args, "blocked_reason", "blockedReason");
    let report_payload = optional_report_payload(args);
    // Issue #516: top-level next_action が無いとき report_payload.next_action を昇格させる。
    let next_action = optional_string(args, "next_action", "nextAction")
        .or_else(|| report_payload.as_ref().and_then(|p| p.next_action.clone()));
    // Issue #516: top-level artifact_path が無いとき report_payload.artifacts[0] を昇格させる。
    let artifact_path = optional_string(args, "artifact_path", "artifactPath").or_else(|| {
        report_payload
            .as_ref()
            .and_then(|p| p.artifacts.first().cloned())
    });
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
        // Issue #594 (Tier S-1): assignee / leader 検証。
        // `team_report` (report.rs:285) で同等のガードを入れた対称穴の補完。
        // これが無いと、同 team の任意 worker が他者 task を `done` 化 + `done_evidence` 捏造して
        // Leader の承認サイクル (chain-of-responsibility) を bypass できてしまう。
        let is_leader = ctx.role.eq_ignore_ascii_case("leader");
        let is_assignee =
            task.assigned_to == ctx.role || task.assigned_to == ctx.agent_id;
        if !is_leader && !is_assignee {
            tracing::warn!(
                team_id = %ctx.team_id,
                agent_id = %ctx.agent_id,
                role = %ctx.role,
                task_id = task_id,
                attempted_status = %status,
                task_assigned_to = %task.assigned_to,
                "[team_update_task] permission denied: caller is not assignee nor leader"
            );
            return Err(ToolError::permission_denied(
                "update_task",
                &ctx.role,
                "update task assigned to another agent",
            )
            .into_err_string());
        }
        if is_done_status(status) && !task.done_criteria.is_empty() {
            let missing = task
                .done_criteria
                .iter()
                .filter(|criterion| {
                    let criterion_key = normalize_criterion(criterion);
                    !done_evidence.iter().any(|evidence| {
                        normalize_criterion(&evidence.criterion) == criterion_key
                            && !evidence.evidence.trim().is_empty()
                    })
                })
                .cloned()
                .collect::<Vec<_>>();
            if !missing.is_empty() {
                return Err(done_evidence_missing(missing));
            }
        }
        task.status = status.to_string();
        task.updated_at = Some(now_iso.clone());
        if !done_evidence.is_empty() {
            task.done_evidence = done_evidence.clone();
        }
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
                    payload: report_payload.clone(),
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
                target_paths: Vec::new(),
                lock_conflicts: Vec::new(),
                pre_approval: None,
                done_criteria: Vec::new(),
                done_evidence: Vec::new(),
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
                target_paths: Vec::new(),
                lock_conflicts: Vec::new(),
                pre_approval: None,
                done_criteria: Vec::new(),
                done_evidence: Vec::new(),
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

    /// Issue #516: `report_payload` (findings/proposal/risks/next_action/artifacts[]) を渡したとき
    /// WorkerReportSnapshot.payload に保存され、artifacts[0] が top-level artifact_path に昇格し、
    /// payload.next_action が top-level next_action に昇格することを確認する。
    #[tokio::test]
    async fn update_task_persists_structured_report_payload() {
        let hub = TeamHub::new(Arc::new(SessionRegistry::new()));
        let team_id = "team-516".to_string();
        {
            let mut state = hub.state.lock().await;
            let team = state
                .teams
                .entry(team_id.clone())
                .or_insert_with(TeamInfo::default);
            team.tasks.push_back(TeamTask {
                id: 11,
                assigned_to: "researcher".into(),
                description: "investigate canvas perf".into(),
                status: "pending".into(),
                created_by: "leader".into(),
                created_at: "2026-05-07T10:00:00Z".into(),
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
        }

        let ctx = CallContext {
            team_id: team_id.clone(),
            role: "researcher".into(),
            agent_id: "vc-r-1".into(),
        };

        team_update_task(
            &hub,
            &ctx,
            &json!({
                "task_id": 11,
                "status": "done",
                "summary": "Found 3 hot paths in canvas store selectors",
                "report_payload": {
                    "findings": "selectorA / selectorB / selectorC are recomputed every frame",
                    "proposal": "memoize via zustand shallow + add equality fn",
                    "risks": [
                        "shallow ではネスト object の差分を取り損ねる可能性",
                        "memoize の TTL を入れないと stale に読まれる"
                    ],
                    "next_action": "実装担当に hand off (selectorA から)",
                    "artifacts": [
                        "tasks/issue-516/findings.md",
                        "tasks/issue-516/profile.json"
                    ]
                }
            }),
        )
        .await
        .expect("team_update_task ok");

        let state = hub.state.lock().await;
        let team = state.teams.get(&team_id).unwrap();
        assert_eq!(team.worker_reports.len(), 1);
        let report = team.worker_reports.back().unwrap();
        let payload = report
            .payload
            .as_ref()
            .expect("payload should be persisted");
        assert_eq!(
            payload.findings.as_deref(),
            Some("selectorA / selectorB / selectorC are recomputed every frame")
        );
        assert_eq!(
            payload.proposal.as_deref(),
            Some("memoize via zustand shallow + add equality fn")
        );
        assert_eq!(payload.risks.len(), 2);
        assert_eq!(payload.artifacts.len(), 2);
        assert_eq!(
            payload.next_action.as_deref(),
            Some("実装担当に hand off (selectorA から)")
        );
        // top-level next_action / artifact_path への昇格を確認
        assert_eq!(
            report.next_action.as_deref(),
            Some("実装担当に hand off (selectorA から)")
        );
        assert_eq!(
            report.artifact_path.as_deref(),
            Some("tasks/issue-516/findings.md")
        );
        // next_actions queue にも積まれているはず (payload.next_action 昇格経由)
        assert_eq!(
            team.next_actions.back().map(String::as_str),
            Some("実装担当に hand off (selectorA から)")
        );
    }

    /// Issue #516: `report_payload` 全フィールドが空 / 未指定なら payload を保存しない (None のまま)。
    #[tokio::test]
    async fn update_task_skips_empty_report_payload() {
        let hub = TeamHub::new(Arc::new(SessionRegistry::new()));
        let team_id = "team-516-empty".to_string();
        {
            let mut state = hub.state.lock().await;
            let team = state
                .teams
                .entry(team_id.clone())
                .or_insert_with(TeamInfo::default);
            team.tasks.push_back(TeamTask {
                id: 12,
                assigned_to: "worker".into(),
                description: "no payload".into(),
                status: "pending".into(),
                created_by: "leader".into(),
                created_at: "2026-05-07T10:00:00Z".into(),
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
        }
        let ctx = CallContext {
            team_id: team_id.clone(),
            role: "worker".into(),
            agent_id: "vc-w-1".into(),
        };
        team_update_task(
            &hub,
            &ctx,
            &json!({
                "task_id": 12,
                "status": "done",
                "summary": "trivial fix",
                "report_payload": { "risks": [], "artifacts": [] }
            }),
        )
        .await
        .expect("team_update_task ok");
        let state = hub.state.lock().await;
        let team = state.teams.get(&team_id).unwrap();
        let report = team.worker_reports.back().unwrap();
        assert!(report.payload.is_none(), "empty payload should not persist");
    }

    #[tokio::test]
    async fn update_task_rejects_done_without_required_evidence() {
        let hub = TeamHub::new(Arc::new(SessionRegistry::new()));
        let team_id = "team-527-missing".to_string();
        {
            let mut state = hub.state.lock().await;
            let team = state
                .teams
                .entry(team_id.clone())
                .or_insert_with(TeamInfo::default);
            team.tasks.push_back(TeamTask {
                id: 21,
                assigned_to: "worker".into(),
                description: "quality gate".into(),
                status: "pending".into(),
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
                done_criteria: vec!["tests pass".into(), "security reviewed".into()],
                done_evidence: Vec::new(),
            });
        }
        let ctx = CallContext {
            team_id: team_id.clone(),
            role: "worker".into(),
            agent_id: "vc-w-527".into(),
        };

        let err = team_update_task(
            &hub,
            &ctx,
            &json!({
                "task_id": 21,
                "status": "done",
                "done_evidence": [
                    { "criterion": "tests pass", "evidence": "cargo test passed" }
                ]
            }),
        )
        .await
        .unwrap_err();

        assert!(err.contains("task_done_evidence_missing"));
        assert!(err.contains("security reviewed"));
        let state = hub.state.lock().await;
        let task = state
            .teams
            .get(&team_id)
            .unwrap()
            .tasks
            .iter()
            .find(|task| task.id == 21)
            .unwrap();
        assert_eq!(task.status, "pending");
        assert!(task.done_evidence.is_empty());
    }

    /// Issue #594 (Tier S-1): 同 team の第三者 worker (assignee でも leader でもない) からの
    /// `team_update_task` は `update_task_permission_denied` で拒否され、task は一切 mutate されない。
    /// done_evidence を捏造しても task.status / task.done_evidence は不変。
    #[tokio::test]
    async fn update_task_rejects_non_assignee_worker() {
        let hub = TeamHub::new(Arc::new(SessionRegistry::new()));
        let team_id = "team-594-non-assignee".to_string();
        {
            let mut state = hub.state.lock().await;
            let team = state
                .teams
                .entry(team_id.clone())
                .or_insert_with(TeamInfo::default);
            team.tasks.push_back(TeamTask {
                id: 31,
                assigned_to: "programmer".into(),
                description: "B's task".into(),
                status: "in_progress".into(),
                created_by: "leader".into(),
                created_at: "2026-05-09T10:00:00Z".into(),
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
                done_criteria: vec!["tests pass".into()],
                done_evidence: Vec::new(),
            });
        }
        // role = "researcher" は task.assigned_to "programmer" と不一致 / agent_id も一致しない。
        let ctx = CallContext {
            team_id: team_id.clone(),
            role: "researcher".into(),
            agent_id: "vc-r-malicious".into(),
        };

        let err = team_update_task(
            &hub,
            &ctx,
            &json!({
                "task_id": 31,
                "status": "done",
                "summary": "fabricated done report",
                "done_evidence": [
                    { "criterion": "tests pass", "evidence": "trust me bro" }
                ]
            }),
        )
        .await
        .unwrap_err();

        assert!(
            err.contains("update_task_permission_denied"),
            "expected permission_denied code, got: {err}"
        );

        let state = hub.state.lock().await;
        let team = state.teams.get(&team_id).unwrap();
        let task = team.tasks.iter().find(|t| t.id == 31).unwrap();
        // 認可拒否されたので、status / done_evidence / summary / updated_at は完全に元のまま。
        assert_eq!(task.status, "in_progress");
        assert!(task.done_evidence.is_empty());
        assert!(task.summary.is_none());
        assert!(task.updated_at.is_none());
        // worker_reports (= leader への通知 backlog) にも積まない
        // (= status を done に書けなかったので report 生成パスを通らない)。
        assert_eq!(team.worker_reports.len(), 0);
    }

    /// Issue #594: leader は assignee でなくても任意 task を更新できる (override 権限)。
    #[tokio::test]
    async fn update_task_allows_leader_override() {
        let hub = TeamHub::new(Arc::new(SessionRegistry::new()));
        let team_id = "team-594-leader".to_string();
        {
            let mut state = hub.state.lock().await;
            let team = state
                .teams
                .entry(team_id.clone())
                .or_insert_with(TeamInfo::default);
            team.tasks.push_back(TeamTask {
                id: 32,
                assigned_to: "programmer".into(),
                description: "task to be cancelled by leader".into(),
                status: "in_progress".into(),
                created_by: "leader".into(),
                created_at: "2026-05-09T10:00:00Z".into(),
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
        }
        let ctx = CallContext {
            team_id: team_id.clone(),
            role: "leader".into(),
            agent_id: "vc-leader-1".into(),
        };

        team_update_task(
            &hub,
            &ctx,
            &json!({
                "task_id": 32,
                "status": "blocked",
                "summary": "leader cancelled this task",
                "blocked_reason": "scope deferred to next sprint"
            }),
        )
        .await
        .expect("leader should be able to update any task");

        let state = hub.state.lock().await;
        let team = state.teams.get(&team_id).unwrap();
        let task = team.tasks.iter().find(|t| t.id == 32).unwrap();
        assert_eq!(task.status, "blocked");
        assert_eq!(task.summary.as_deref(), Some("leader cancelled this task"));
    }

    /// Issue #594: assignee 一致は role 文字列だけでなく agent_id でも判定される
    /// (例: leader が個別 agent_id を直接 assigned_to に書いたケース)。
    #[tokio::test]
    async fn update_task_allows_assignee_by_agent_id() {
        let hub = TeamHub::new(Arc::new(SessionRegistry::new()));
        let team_id = "team-594-agent-id".to_string();
        let worker_aid = "vc-prog-special".to_string();
        {
            let mut state = hub.state.lock().await;
            let team = state
                .teams
                .entry(team_id.clone())
                .or_insert_with(TeamInfo::default);
            team.tasks.push_back(TeamTask {
                id: 33,
                // role 文字列ではなく agent_id を直接 assigned_to に書くケース。
                assigned_to: worker_aid.clone(),
                description: "task pinned to a specific agent_id".into(),
                status: "in_progress".into(),
                created_by: "leader".into(),
                created_at: "2026-05-09T10:00:00Z".into(),
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
        }
        let ctx = CallContext {
            team_id: team_id.clone(),
            role: "programmer".into(),
            agent_id: worker_aid.clone(),
        };

        team_update_task(
            &hub,
            &ctx,
            &json!({ "task_id": 33, "status": "in_progress", "summary": "ack" }),
        )
        .await
        .expect("assignee identified by agent_id should be allowed");

        let state = hub.state.lock().await;
        let team = state.teams.get(&team_id).unwrap();
        let task = team.tasks.iter().find(|t| t.id == 33).unwrap();
        assert_eq!(task.summary.as_deref(), Some("ack"));
    }

    #[tokio::test]
    async fn update_task_accepts_done_when_all_evidence_is_present() {
        let hub = TeamHub::new(Arc::new(SessionRegistry::new()));
        let team_id = "team-527-ok".to_string();
        {
            let mut state = hub.state.lock().await;
            let team = state
                .teams
                .entry(team_id.clone())
                .or_insert_with(TeamInfo::default);
            team.tasks.push_back(TeamTask {
                id: 22,
                assigned_to: "worker".into(),
                description: "quality gate".into(),
                status: "pending".into(),
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
                done_criteria: vec!["tests pass".into(), "security reviewed".into()],
                done_evidence: Vec::new(),
            });
        }
        let ctx = CallContext {
            team_id: team_id.clone(),
            role: "worker".into(),
            agent_id: "vc-w-527-ok".into(),
        };

        team_update_task(
            &hub,
            &ctx,
            &json!({
                "task_id": 22,
                "status": "done",
                "summary": "quality gate cleared",
                "done_evidence": [
                    { "criterion": "tests pass", "evidence": "cargo test --lib passed" },
                    { "criterion": "security reviewed", "evidence": "no secret or injection path changed" }
                ]
            }),
        )
        .await
        .expect("done evidence should satisfy criteria");

        let state = hub.state.lock().await;
        let team = state.teams.get(&team_id).unwrap();
        let task = team.tasks.iter().find(|task| task.id == 22).unwrap();
        assert_eq!(task.status, "done");
        assert_eq!(task.done_evidence.len(), 2);
        assert_eq!(team.worker_reports.len(), 1);
    }
}

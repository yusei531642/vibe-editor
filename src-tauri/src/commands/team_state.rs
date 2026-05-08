// team_state.* — durable TeamHub orchestration state.
//
// TeamHub itself is an in-memory socket hub. Issue #470 requires the
// orchestration layer (active leader, tasks, worker reports, handoff lifecycle,
// and human gates) to survive handoff / app restart, so this module owns the
// on-disk state under ~/.vibe-editor/team-state/.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tokio::fs;

use crate::commands::team_history::HandoffReference;

pub const TEAM_STATE_SCHEMA_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileLockConflictSnapshot {
    pub path: String,
    pub holder_agent_id: String,
    pub holder_role: String,
    pub acquired_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TaskPreApprovalSnapshot {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_actions: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TaskDoneEvidenceSnapshot {
    pub criterion: String,
    pub evidence: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TeamTaskSnapshot {
    pub id: u32,
    pub assigned_to: String,
    pub description: String,
    pub status: String,
    pub created_by: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_action: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_path: Option<String>,
    #[serde(default)]
    pub blocked_by_human_gate: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required_human_decision: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub target_paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub lock_conflicts: Vec<FileLockConflictSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pre_approval: Option<TaskPreApprovalSnapshot>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub done_criteria: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub done_evidence: Vec<TaskDoneEvidenceSnapshot>,
}

/// Issue #516: 統合フェーズで Leader が複数 worker の成果を突き合わせるための構造化フィールド。
///
/// 既存の単発フィールド (`summary` / `next_action` / `artifact_path`) と重複しても構わない設計で、
/// 後方互換性のため全フィールドが optional。Leader が integrate するときに findings/proposal/risks
/// を横断比較しやすくすることが目的。
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkerReportPayload {
    /// 調査・実装で得られた発見・観察結果 (markdown / プレーンテキスト)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub findings: Option<String>,
    /// 採用方針の推奨 (Leader 向けの提案)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposal: Option<String>,
    /// リスク・既知の懸念事項 (Leader が他 worker と突き合わせる)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub risks: Vec<String>,
    /// 次にやるべき具体的な行動 (top-level next_action と重複可)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_action: Option<String>,
    /// 複数の生成物パス (top-level artifact_path より柔軟)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artifacts: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkerReportSnapshot {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<u32>,
    pub from_role: String,
    pub from_agent_id: String,
    pub kind: String,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_action: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_path: Option<String>,
    /// Issue #516: 構造化 report_payload (integrator が複数 worker の成果を突き合わせるため)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<WorkerReportPayload>,
    pub created_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct HumanGateState {
    #[serde(default)]
    pub blocked: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required_decision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct HandoffLifecycleEvent {
    pub handoff_id: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub created_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TeamOrchestrationState {
    pub schema_version: u32,
    pub project_root: String,
    pub team_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_leader_agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_handoff: Option<HandoffReference>,
    #[serde(default)]
    pub tasks: Vec<TeamTaskSnapshot>,
    #[serde(default)]
    pub pending_tasks: Vec<TeamTaskSnapshot>,
    #[serde(default)]
    pub worker_reports: Vec<WorkerReportSnapshot>,
    #[serde(default)]
    pub human_gate: HumanGateState,
    #[serde(default)]
    pub next_actions: Vec<String>,
    #[serde(default)]
    pub handoff_events: Vec<HandoffLifecycleEvent>,
    pub updated_at: String,
}

impl Default for TeamOrchestrationState {
    fn default() -> Self {
        Self {
            schema_version: TEAM_STATE_SCHEMA_VERSION,
            project_root: String::new(),
            team_id: String::new(),
            active_leader_agent_id: None,
            latest_handoff: None,
            tasks: Vec::new(),
            pending_tasks: Vec::new(),
            worker_reports: Vec::new(),
            human_gate: HumanGateState::default(),
            next_actions: Vec::new(),
            handoff_events: Vec::new(),
            updated_at: Utc::now().to_rfc3339(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TeamOrchestrationSummary {
    pub state_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_leader_agent_id: Option<String>,
    #[serde(default)]
    pub pending_task_count: usize,
    #[serde(default)]
    pub worker_report_count: usize,
    #[serde(default)]
    pub blocked_by_human_gate: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required_human_decision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_handoff_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_handoff_status: Option<String>,
    pub updated_at: String,
}

fn state_root() -> PathBuf {
    crate::util::config_paths::vibe_root().join("team-state")
}

fn project_key(project_root: &str) -> String {
    let normalized = crate::pty::path_norm::normalize_project_root(project_root);
    URL_SAFE_NO_PAD.encode(normalized.as_bytes())
}

fn safe_segment(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        "unknown".to_string()
    } else {
        out.chars().take(96).collect()
    }
}

pub fn team_state_path(project_root: &str, team_id: &str) -> PathBuf {
    state_root()
        .join(project_key(project_root))
        .join(format!("{}.json", safe_segment(team_id)))
}

async fn ensure_private_dir(dir: &Path) -> crate::commands::error::CommandResult<()> {
    fs::create_dir_all(dir).await.map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn is_open_task(status: &str) -> bool {
    !matches!(
        status.trim().to_ascii_lowercase().as_str(),
        "done" | "completed" | "complete" | "cancelled" | "canceled"
    )
}

fn normalize(mut state: TeamOrchestrationState) -> TeamOrchestrationState {
    state.schema_version = TEAM_STATE_SCHEMA_VERSION;
    state.pending_tasks = state
        .tasks
        .iter()
        .filter(|task| is_open_task(&task.status))
        .cloned()
        .collect();
    if state.updated_at.trim().is_empty() {
        state.updated_at = Utc::now().to_rfc3339();
    }
    state
}

pub async fn load_orchestration_state(
    project_root: &str,
    team_id: &str,
) -> Option<TeamOrchestrationState> {
    let path = team_state_path(project_root, team_id);
    let bytes = fs::read(&path).await.ok()?;
    let state = serde_json::from_slice::<TeamOrchestrationState>(&bytes).ok()?;
    Some(normalize(state))
}

pub async fn save_orchestration_state(
    mut state: TeamOrchestrationState,
) -> crate::commands::error::CommandResult<TeamOrchestrationState> {
    state.updated_at = Utc::now().to_rfc3339();
    state = normalize(state);
    let path = team_state_path(&state.project_root, &state.team_id);
    if let Some(parent) = path.parent() {
        ensure_private_dir(parent).await?;
    }
    let json = serde_json::to_vec_pretty(&state).map_err(|e| e.to_string())?;
    crate::commands::atomic_write::atomic_write(&path, &json)
        .await
        .map_err(|e| e.to_string())?;
    Ok(state)
}

pub fn summarize_state(
    project_root: &str,
    state: &TeamOrchestrationState,
) -> TeamOrchestrationSummary {
    let path = team_state_path(project_root, &state.team_id);
    TeamOrchestrationSummary {
        state_path: path.to_string_lossy().into_owned(),
        active_leader_agent_id: state.active_leader_agent_id.clone(),
        pending_task_count: state.pending_tasks.len(),
        worker_report_count: state.worker_reports.len(),
        blocked_by_human_gate: state.human_gate.blocked,
        blocked_reason: state.human_gate.reason.clone(),
        required_human_decision: state.human_gate.required_decision.clone(),
        latest_handoff_id: state.latest_handoff.as_ref().map(|h| h.id.clone()),
        latest_handoff_status: state.latest_handoff.as_ref().map(|h| h.status.clone()),
        updated_at: state.updated_at.clone(),
    }
}

pub async fn orchestration_summary(
    project_root: &str,
    team_id: &str,
) -> Option<TeamOrchestrationSummary> {
    let state = load_orchestration_state(project_root, team_id).await?;
    Some(summarize_state(project_root, &state))
}

#[tauri::command]
pub async fn team_state_read(
    project_root: String,
    team_id: String,
) -> Option<TeamOrchestrationState> {
    load_orchestration_state(&project_root, &team_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_tasks_exclude_done_tasks() {
        let state = normalize(TeamOrchestrationState {
            project_root: "C:/repo".into(),
            team_id: "team-1".into(),
            tasks: vec![
                TeamTaskSnapshot {
                    id: 1,
                    status: "done".into(),
                    ..TeamTaskSnapshot::default()
                },
                TeamTaskSnapshot {
                    id: 2,
                    status: "blocked".into(),
                    ..TeamTaskSnapshot::default()
                },
            ],
            ..TeamOrchestrationState::default()
        });
        assert_eq!(state.pending_tasks.len(), 1);
        assert_eq!(state.pending_tasks[0].id, 2);
    }
}

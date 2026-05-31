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

/// TeamHub orchestration state JSON の現行 schema version。
///
/// Issue #739: 実体は `commands::schema_version` に集約した。本 re-export で旧 import パス
/// (`commands::team_state::TEAM_STATE_SCHEMA_VERSION`) は維持される。
pub use crate::commands::schema_version::TEAM_STATE_SCHEMA_VERSION;

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

/// Issue #572: `team_report` の findings 1 件分。`severity` は `high` / `medium` / `low` の
/// いずれか (Hub 側で trim + lowercase 後に validate)。`file` は repository-relative を推奨だが
/// 自由文字列。`message` は人間可読な要約。
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TeamReportFinding {
    pub severity: String,
    pub file: String,
    pub message: String,
}

/// Issue #572: `team_report` で worker → Leader へ返す構造化レポート 1 件。
///
/// 既存の `WorkerReportSnapshot` (= `team_send` / `team_update_task` が積む完了経過ログ) とは
/// 別 channel として独立した struct を持つ。`team_report` は「task 単位での完成形 / blocked 形」
/// を明示するためのもので、Leader が `team_get_tasks` で task に紐付けて読む。
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TeamReportSnapshot {
    /// 一意 id (`report-<task_id>-<timestamp>` 形式、Hub が採番)
    pub id: String,
    /// caller が指定した task_id 文字列。`team_assign_task` 経由の task と紐付けるなら数値文字列、
    /// 外部 planner の id (string) なら任意文字列のまま保持する。
    pub task_id: String,
    /// `task_id` を u32 として parse できた場合だけ Some。`team_get_tasks` の attach 判定で使う。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id_num: Option<u32>,
    pub from_role: String,
    pub from_agent_id: String,
    /// `done` / `blocked` / `needs_input` / `failed` のいずれか (Hub 側で validate 済み)。
    pub status: String,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub findings: Vec<TeamReportFinding>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changed_files: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artifact_refs: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub next_actions: Vec<String>,
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
    /// Issue #572: `team_report` で受け取った構造化レポートのバックログ (新しい順に積む)。
    /// 既存 JSON ファイル (schema_version=1) には存在しないため `#[serde(default)]` で
    /// 空配列扱いし、書き出し時はフィールドが空ならスキップして無駄な diff を出さない。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub team_reports: Vec<TeamReportSnapshot>,
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
            team_reports: Vec::new(),
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
    load_orchestration_state_from_path(&path).await
}

/// Issue #830: orchestration state を 1 ファイルから読み込む内部実装。
///
/// 旧 `load_orchestration_state` は read 失敗と parse 失敗を両方 `.ok()?` で `None` に
/// 丸め込み、ログを一切出さなかった。`register_team` はこの `None` を「永続化が無い」と
/// 等価に扱うため、`<team>.json` が部分書き込みや手編集で 1 byte でも壊れていると、leader
/// handoff・open task・human gate 状態がすべて **silent に消失** していた (最も発見が難しい
/// 類の障害)。fail-safe にするため:
///   - read 失敗は NotFound (= 未保存 / 初回起動) を silent に、それ以外の IO エラーは warn。
///   - parse 失敗は warn + 破損ファイルを `.corrupt` へ best-effort 退避する (後から調査・
///     手動復旧でき、退避後の原本は次回 save で健全な状態に上書きされる)。
///   - 読み込んだ schema_version が現行と異なる場合は warn (`normalize` が無条件で上書きする
///     前に検知する。将来の migration 判定の足場)。
async fn load_orchestration_state_from_path(path: &Path) -> Option<TeamOrchestrationState> {
    let bytes = match fs::read(path).await {
        Ok(b) => b,
        Err(e) => {
            // NotFound は通常状態 (team-state 未保存 / 初回起動) なので silent。
            // それ以外の IO エラー (権限 / I/O 障害) は痕跡を残す。
            if e.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(
                    "[team_state] failed to read orchestration state at {}: {e}",
                    path.display()
                );
            }
            return None;
        }
    };
    match serde_json::from_slice::<TeamOrchestrationState>(&bytes) {
        Ok(state) => {
            if state.schema_version != TEAM_STATE_SCHEMA_VERSION {
                tracing::warn!(
                    "[team_state] orchestration state at {} has schema_version {} (expected {}); \
                     loading as-is",
                    path.display(),
                    state.schema_version,
                    TEAM_STATE_SCHEMA_VERSION
                );
            }
            Some(normalize(state))
        }
        Err(e) => {
            tracing::warn!(
                "[team_state] failed to parse orchestration state at {}: {e}; backing up corrupt \
                 file and skipping restore (task/handoff/human-gate state will be recreated on next save)",
                path.display()
            );
            // Issue #853: load 時に読んだ破損 bytes を渡し、退避直前に再 read して
            // 内容が変化していない (= まだ破損したまま) ときだけ退避する。並行 save が
            // valid file を置いていれば bytes が変化しているので退避を skip し、valid state を
            // `.corrupt` へ巻き込まない (TOCTOU の解消)。
            backup_corrupt_state_file(path, &bytes).await;
            None
        }
    }
}

/// Issue #830: 破損した team-state JSON を `<file>.corrupt` (衝突時は `.corrupt.1` ..
/// `.corrupt.9`) に best-effort で退避する。退避できれば原本は消えるので、次回
/// `save_orchestration_state` が健全な状態で上書きできる。退避失敗 (rename 不可 / backup
/// が増え過ぎ) は warn に留め、load 自体は失敗させない。
///
/// Issue #853 (TOCTOU 修正): `corrupt_bytes` は load 時に読んで parse に失敗した原本の bytes。
/// rename は lock 外で走るため、その間に並行 `save_orchestration_state` (atomic_write) が
/// **valid な file** を同 path に置き換えうる。素朴に rename するとこの valid file を
/// `.corrupt` へ追い出し、save 直後の健全な state を失う race があった。退避の直前に現在の
/// file bytes を再 read し、`corrupt_bytes` と **完全一致するときだけ** 退避する。一致しない
/// (= 並行 save で内容が変わった / 既に他経路で退避され消えた) 場合は退避を skip し、active
/// path を温存する。これで「valid file を退避しない」不変条件を保証する。
async fn backup_corrupt_state_file(path: &Path, corrupt_bytes: &[u8]) {
    let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
        tracing::warn!(
            "[team_state] cannot derive file name for corrupt backup of {}",
            path.display()
        );
        return;
    };
    let Some(parent) = path.parent() else {
        tracing::warn!(
            "[team_state] cannot derive parent dir for corrupt backup of {}",
            path.display()
        );
        return;
    };
    // Issue #853: 退避直前の再検証。並行 save が割り込んで file が valid に置き換わって
    // いれば bytes が変化しているので退避せずに抜ける (valid state を巻き込まない)。
    // read 失敗 (並行退避で消えた等) も退避対象が消えたとみなし skip する。
    match fs::read(path).await {
        Ok(current) if current == corrupt_bytes => {
            // 依然として load 時の破損 bytes と同一。退避を続行する。
        }
        Ok(_) => {
            tracing::info!(
                "[team_state] corrupt backup skipped: {} changed since load (likely a concurrent \
                 valid save); not evicting the active file",
                path.display()
            );
            return;
        }
        Err(e) => {
            tracing::info!(
                "[team_state] corrupt backup skipped: cannot re-read {} ({e}); file may have been \
                 replaced or removed by a concurrent save",
                path.display()
            );
            return;
        }
    }
    // 既存 backup を上書きしない (forensic 情報を保持する) ため、空きスロットを探す。
    for idx in 0..=9u32 {
        let candidate_name = if idx == 0 {
            format!("{file_name}.corrupt")
        } else {
            format!("{file_name}.corrupt.{idx}")
        };
        let candidate = parent.join(&candidate_name);
        if fs::metadata(&candidate).await.is_ok() {
            continue;
        }
        match fs::rename(path, &candidate).await {
            Ok(()) => {
                tracing::warn!(
                    "[team_state] moved corrupt orchestration state to {}",
                    candidate.display()
                );
                return;
            }
            Err(e) => {
                tracing::warn!(
                    "[team_state] failed to move corrupt state {} -> {}: {e}",
                    path.display(),
                    candidate.display()
                );
                return;
            }
        }
    }
    tracing::warn!(
        "[team_state] too many corrupt backups already exist for {}; leaving file in place",
        path.display()
    );
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

/// Issue #600 (Tier A-2 security): renderer から `project_root` を受け取って team-state を
/// 返す IPC。`AppState` の active project_root と canonicalize 比較で一致しないと reject する
/// (cross-project leak 防止)。一致しない場合は `CommandError::Authz` が返り、renderer 側は
/// `.catch` で握り潰す (`use-team-dashboard.ts:120`)。
///
/// 戻り値は `Result<Option<...>>`:
/// - `Ok(Some(state))` — active project と一致 + state ファイルが存在
/// - `Ok(None)` — active project と一致するが state ファイルが未保存 (= 通常状態の一つ)
/// - `Err(CommandError::Authz)` — project_root が active と不一致 / 未設定 / canonicalize 失敗
#[tauri::command]
pub async fn team_state_read(
    state: tauri::State<'_, crate::state::AppState>,
    project_root: String,
    team_id: String,
) -> crate::commands::error::CommandResult<Option<TeamOrchestrationState>> {
    crate::commands::authz::assert_active_project_root(&state.project_root, &project_root).await?;
    Ok(load_orchestration_state(&project_root, &team_id).await)
}

/// Issue #578: Canvas (= Tauri webview) が非表示の間に `team:recruit-request` が走った
/// 観測点を tracing ログに 1 行残すだけの軽量 endpoint。renderer 側 `useRecruitListener`
/// が hidden 経過時間 >= 5000ms (env `VIBE_TEAM_RECRUIT_HIDDEN_THRESHOLD_MS` で調整可能)
/// の条件を満たした recruit に対してのみ呼ぶ。短時間 hidden で info ログを汚染しない設計。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecruitObservedWhileHiddenArgs {
    pub team_id: String,
    pub agent_id: String,
    pub hidden_for_ms: u64,
}

#[tauri::command]
pub async fn recruit_observed_while_hidden(
    args: RecruitObservedWhileHiddenArgs,
) -> crate::commands::error::CommandResult<()> {
    // Issue #624 (Security): renderer 由来 string が tracing 行に直接乗るため、
    // (1) [A-Za-z0-9_-]{1,64} の id segment 検証で改行 / 制御文字 / shell metachar を弾き、
    // (2) sanitize_for_log で出力直前にも追加防御する (defense-in-depth)。
    crate::commands::validation::validate_id_segment("team_id", &args.team_id)?;
    crate::commands::validation::validate_id_segment("agent_id", &args.agent_id)?;
    tracing::info!(
        target: "teamhub",
        team_id = %crate::commands::validation::sanitize_for_log(&args.team_id, 64),
        agent_id = %crate::commands::validation::sanitize_for_log(&args.agent_id, 64),
        hidden_for_ms = args.hidden_for_ms,
        "[teamhub] recruit observed while canvas hidden"
    );
    Ok(())
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

    /// Issue #830: 未保存 (ファイル不在) は silent に None を返し、退避ファイルも作らない。
    #[tokio::test]
    async fn load_from_path_returns_none_for_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing.json");
        assert!(load_orchestration_state_from_path(&path).await.is_none());
        assert!(
            fs::metadata(dir.path().join("missing.json.corrupt"))
                .await
                .is_err(),
            "missing file must not produce a corrupt backup"
        );
    }

    /// Issue #830: 正常な JSON はこれまで通り読み込めて normalize される (回帰防止)。
    #[tokio::test]
    async fn load_from_path_parses_valid_state() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("team.json");
        let state = TeamOrchestrationState {
            project_root: "C:/repo".into(),
            team_id: "team-x".into(),
            tasks: vec![TeamTaskSnapshot {
                id: 5,
                status: "in_progress".into(),
                ..TeamTaskSnapshot::default()
            }],
            ..TeamOrchestrationState::default()
        };
        let json = serde_json::to_vec_pretty(&state).unwrap();
        fs::write(&path, &json).await.unwrap();

        let loaded = load_orchestration_state_from_path(&path)
            .await
            .expect("valid state should load");
        assert_eq!(loaded.team_id, "team-x");
        assert_eq!(loaded.pending_tasks.len(), 1);
    }

    /// Issue #830 (core): 破損 JSON は silent に捨てず、`.corrupt` に退避してから None を返す。
    /// 退避後は原本が消えるので、次回 save が健全な状態で上書きできる。
    #[tokio::test]
    async fn load_from_path_backs_up_corrupt_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("team.json");
        let corrupt = b"{ this is not valid json ]";
        fs::write(&path, corrupt).await.unwrap();

        let loaded = load_orchestration_state_from_path(&path).await;
        assert!(loaded.is_none(), "corrupt JSON must not silently load");

        // 原本は退避されて消え、`.corrupt` に同じ内容が残っている。
        assert!(
            fs::metadata(&path).await.is_err(),
            "corrupt original should be moved away"
        );
        let backup = dir.path().join("team.json.corrupt");
        let backup_bytes = fs::read(&backup).await.expect("corrupt backup must exist");
        assert_eq!(backup_bytes, corrupt);
    }

    /// Issue #830: 既に `.corrupt` がある場合は上書きせず `.corrupt.1` に退避する (forensic 保持)。
    #[tokio::test]
    async fn backup_corrupt_state_file_does_not_clobber_existing_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("team.json");
        fs::write(&path, b"corrupt-2").await.unwrap();
        fs::write(dir.path().join("team.json.corrupt"), b"corrupt-1")
            .await
            .unwrap();

        // Issue #853: 退避直前に再 read される bytes が load 時の破損 bytes と一致するので退避続行。
        backup_corrupt_state_file(&path, b"corrupt-2").await;

        // 既存 backup は不変、新 backup は `.corrupt.1` に置かれる。
        assert_eq!(
            fs::read(dir.path().join("team.json.corrupt"))
                .await
                .unwrap(),
            b"corrupt-1"
        );
        assert_eq!(
            fs::read(dir.path().join("team.json.corrupt.1"))
                .await
                .unwrap(),
            b"corrupt-2"
        );
        assert!(fs::metadata(&path).await.is_err());
    }

    /// Issue #853 (TOCTOU 回帰テスト): load が破損 bytes を読んだ後、退避が走る前に並行 save が
    /// **valid な内容** で同 path を置き換えた場合、退避はその valid file を `.corrupt` へ追い出して
    /// はならない。`backup_corrupt_state_file` に load 時の破損 bytes を渡し、退避直前の再 read で
    /// 内容が変化していれば skip することを検証する。
    ///
    /// 修正前 (素の rename) はここで active file (valid) が `.corrupt` に移動して save 直後の
    /// 健全な state を失うため、この assert は fail する。修正後は valid file が原 path に温存される。
    #[tokio::test]
    async fn backup_corrupt_state_file_does_not_evict_concurrently_saved_valid_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("team.json");

        // load 時に読んだ破損 bytes。
        let corrupt_bytes = b"{ this is not valid json ]".to_vec();

        // 退避が走る前に並行 save が valid file を置いた状況を再現する
        // (file は corrupt_bytes とは異なる valid な内容になっている)。
        let valid_bytes = br#"{"schemaVersion":1,"teamId":"t","projectRoot":"/p"}"#.to_vec();
        fs::write(&path, &valid_bytes).await.unwrap();

        backup_corrupt_state_file(&path, &corrupt_bytes).await;

        // valid file は原 path にそのまま残り、`.corrupt` には退避されていない。
        assert_eq!(
            fs::read(&path).await.expect("valid file must remain at the active path"),
            valid_bytes,
            "concurrently saved valid state must not be evicted from the active path"
        );
        assert!(
            fs::metadata(dir.path().join("team.json.corrupt"))
                .await
                .is_err(),
            "no corrupt backup should be created when the file changed to a valid one"
        );
    }

    /// Issue #853: 破損 bytes が退避直前まで変化していない (= 並行 save が無い) 通常ケースでは
    /// 従来どおり `.corrupt` へ退避し、原本を消す。再検証の追加で正常系が壊れていないことを確認。
    #[tokio::test]
    async fn backup_corrupt_state_file_still_backs_up_unchanged_corrupt_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("team.json");
        let corrupt_bytes = b"{ broken json".to_vec();
        fs::write(&path, &corrupt_bytes).await.unwrap();

        backup_corrupt_state_file(&path, &corrupt_bytes).await;

        assert!(
            fs::metadata(&path).await.is_err(),
            "unchanged corrupt file should still be moved away"
        );
        assert_eq!(
            fs::read(dir.path().join("team.json.corrupt"))
                .await
                .expect("corrupt backup must exist"),
            corrupt_bytes
        );
    }
}

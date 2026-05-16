//! チーム登録 / 破棄と orchestration state の永続化 impl。
//!
//! Issue #736: 旧 `state.rs` から `register_team` / `clear_team` / `persist_team_state` /
//! `record_handoff_lifecycle` と動的ロール復元ヘルパを切り出し。

use crate::commands::team_state::{TeamOrchestrationState, TEAM_STATE_SCHEMA_VERSION};
use crate::team_hub::protocol::consts::MAX_HANDOFF_EVENTS;
use crate::team_hub::TeamHub;
use anyhow::Result;

use super::hub_state::{TeamInfo, TeamTask};

impl TeamHub {
    /// チームを active list に追加 (renderer の setupTeamMcp 経由)
    pub async fn register_team(&self, team_id: &str, name: &str, project_root: Option<&str>) {
        if team_id.is_empty() || team_id == "_init" {
            return;
        }
        let persisted = match project_root.map(str::trim).filter(|v| !v.is_empty()) {
            Some(root) => {
                crate::commands::team_state::load_orchestration_state(root, team_id).await
            }
            None => None,
        };
        // Issue #513: ~/.vibe-editor/role-profiles.json#dynamic[] から該当 team_id の entry を抽出。
        // role-profiles.json は user-global (project_root 非依存) なので、project_root の有無に
        // 関わらず実行する。読み込み失敗 / 古い JSON (dynamic フィールドなし) は空配列扱い。
        // state.lock の前に async I/O を済ませ、lock を保持中に file read をしないようにしている。
        let persisted_dynamic_entries = load_persisted_dynamic_for_team(team_id).await;

        let mut s = self.state.lock().await;
        s.active_teams.insert(team_id.to_string());
        let team = s
            .teams
            .entry(team_id.to_string())
            .or_insert_with(TeamInfo::default);
        if let Some(root) = project_root.map(str::trim).filter(|v| !v.is_empty()) {
            team.project_root = Some(root.to_string());
        }
        if !name.is_empty() {
            team.name = name.to_string();
        }
        if let Some(persisted) = persisted {
            if team.active_leader_agent_id.is_none() {
                team.active_leader_agent_id = persisted.active_leader_agent_id;
            }
            if team.latest_handoff.is_none() {
                team.latest_handoff = persisted.latest_handoff;
            }
            if team.tasks.is_empty() {
                team.tasks = persisted
                    .tasks
                    .into_iter()
                    .map(TeamTask::from_snapshot)
                    .collect();
                team.next_task_id = team.tasks.iter().map(|task| task.id).max().unwrap_or(0);
            }
            if team.worker_reports.is_empty() {
                team.worker_reports = persisted.worker_reports.into_iter().collect();
            }
            // Issue #572: `team_report` 由来の構造化レポート backlog を永続化から復元する。
            // worker_reports と独立した channel として持つ (= structured report の意味的分離)。
            if team.team_reports.is_empty() {
                team.team_reports = persisted.team_reports.into_iter().collect();
            }
            if team.handoff_events.is_empty() {
                team.handoff_events = persisted.handoff_events.into_iter().collect();
            }
            if !persisted.next_actions.is_empty() && team.next_actions.is_empty() {
                team.next_actions = persisted.next_actions.into_iter().collect();
            }
            if persisted.human_gate.blocked {
                team.human_gate = persisted.human_gate;
            }
        }
        drop(s);
        // Issue #513: state.lock を drop した後で `replay_persisted_dynamic_roles_for_team` を呼ぶ。
        // この関数は内部で hub.state.lock() を取るので、外側 lock を保持したまま呼ぶと deadlock する。
        // 永続化が空 (entry 0 件) のチームは `replace_dynamic_roles` で空集合を投入することになるが、
        // 既存 in-memory が空のままなら no-op、既存に entry が居れば「永続化済 = 真の状態」として
        // 完全置換する設計 (= renderer 側 cache が永続化と乖離していた場合に永続化を勝者とする)。
        if !persisted_dynamic_entries.is_empty() {
            let skipped =
                crate::team_hub::protocol::dynamic_role::replay_persisted_dynamic_roles_for_team(
                    self,
                    team_id,
                    persisted_dynamic_entries,
                )
                .await;
            if skipped > 0 {
                tracing::warn!(
                    "[register_team] team={team_id}: {skipped} persisted dynamic entries skipped (expired / mismatch)"
                );
            }
        }

        // Issue #512: チーム登録ごとに `<project_root>/.vibe-team/tmp/` の古い spool ファイルを
        // best-effort で cleanup する。アプリ起動時のみだと長時間 session で TTL 超過が発生し続ける
        // ため、register_team (= setup MCP 経路) ごとに 1 回だけ走らせる。fire-and-forget で
        // register_team の戻りを遅延させない。
        if let Some(root) = project_root.map(str::trim).filter(|p| !p.is_empty()) {
            let root_owned = root.to_string();
            tokio::spawn(async move {
                crate::team_hub::spool::cleanup_old_spools(&root_owned).await;
            });
        }
    }

    /// チームを active list から外す。戻り値が true なら active が 0 → MCP 設定削除可
    pub async fn clear_team(&self, team_id: &str) -> bool {
        let mut s = self.state.lock().await;
        s.teams.remove(team_id);
        s.active_teams.remove(team_id);
        // 動的ロールもチーム単位でクリア (チーム破棄でロール定義を残す意味は無い)
        s.dynamic_roles.remove(team_id);
        s.active_teams.is_empty()
    }

    /// Issue #359: app 側の leader replacement 経路から active leader を切り替える。
    /// 通常の team_recruit singleton 制約を迂回して同一 teamId に新 leader を直接 spawn するため、
    /// role 宛て配送だけは Hub 側で単一 leader に固定する。
    pub async fn set_active_leader(&self, team_id: &str, agent_id: Option<String>) {
        if team_id.trim().is_empty() {
            return;
        }
        {
            let mut s = self.state.lock().await;
            let team = s
                .teams
                .entry(team_id.to_string())
                .or_insert_with(TeamInfo::default);
            team.active_leader_agent_id = agent_id.filter(|v| !v.trim().is_empty());
        }
        if let Err(e) = self.persist_team_state(team_id).await {
            tracing::warn!("[teamhub] persist active leader failed: {e}");
        }
    }

    /// Issue #470: TeamHub の in-memory orchestration state を team-state に保存する。
    pub async fn persist_team_state(&self, team_id: &str) -> Result<(), String> {
        let snapshot = {
            let s = self.state.lock().await;
            let Some(team) = s.teams.get(team_id) else {
                return Ok(());
            };
            let Some(project_root) = team.project_root.clone() else {
                return Ok(());
            };
            if project_root.trim().is_empty() {
                return Ok(());
            }
            TeamOrchestrationState {
                schema_version: TEAM_STATE_SCHEMA_VERSION,
                project_root,
                team_id: team_id.to_string(),
                active_leader_agent_id: team.active_leader_agent_id.clone(),
                latest_handoff: team.latest_handoff.clone(),
                tasks: team.tasks.iter().map(TeamTask::to_snapshot).collect(),
                pending_tasks: Vec::new(),
                worker_reports: team.worker_reports.iter().cloned().collect(),
                // Issue #572: `team_report` 由来の構造化レポート backlog を永続化対象に含める。
                team_reports: team.team_reports.iter().cloned().collect(),
                human_gate: team.human_gate.clone(),
                next_actions: team.next_actions.iter().cloned().collect(),
                handoff_events: team.handoff_events.iter().cloned().collect(),
                updated_at: chrono::Utc::now().to_rfc3339(),
            }
        };
        Ok(
            crate::commands::team_state::save_orchestration_state(snapshot)
                .await
                .map(|_| ())?,
        )
    }

    /// Issue #470: handoff lifecycle を handoff store と team-state の両方へ記録する。
    pub async fn record_handoff_lifecycle(
        &self,
        team_id: &str,
        handoff_id: &str,
        status: &str,
        agent_id: Option<String>,
        note: Option<String>,
    ) -> Result<(), String> {
        let project_root = {
            let s = self.state.lock().await;
            s.teams
                .get(team_id)
                .and_then(|team| team.project_root.clone())
                .ok_or_else(|| "project_root is not registered for this team".to_string())?
        };
        let handoff = crate::commands::handoffs::update_handoff_status_file(
            &project_root,
            Some(team_id),
            handoff_id,
            status,
            agent_id.clone(),
        )
        .await?;
        let reference = crate::commands::handoffs::handoff_reference_of(&handoff);
        {
            let mut s = self.state.lock().await;
            let team = s
                .teams
                .entry(team_id.to_string())
                .or_insert_with(TeamInfo::default);
            team.project_root.get_or_insert(project_root);
            team.latest_handoff = Some(reference);
            team.handoff_events
                .push_back(crate::commands::team_state::HandoffLifecycleEvent {
                    handoff_id: handoff_id.to_string(),
                    status: crate::commands::handoffs::normalize_status(status)
                        .unwrap_or(status)
                        .to_string(),
                    agent_id,
                    note,
                    created_at: chrono::Utc::now().to_rfc3339(),
                });
            while team.handoff_events.len() > MAX_HANDOFF_EVENTS {
                let _ = team.handoff_events.pop_front();
            }
        }
        self.persist_team_state(team_id).await
    }
}

/// Issue #513: `~/.vibe-editor/role-profiles.json#dynamic[]` から **指定 team_id に紐付く
/// entry だけ** を抽出して返す内部 helper。`register_team` の前段で呼び、Hub state.lock を
/// 取らずに async I/O を済ませてから replay する設計。
///
/// 失敗時 (file 不在 / parse 失敗 / dynamic フィールドなし) は **空配列** を返す
/// (= 「永続化された動的ロールがない」と意味的に等価)。parse 失敗時は警告ログを残すが、
/// チーム起動自体は失敗させない (= ユーザーが旧 builtin / custom フィールドだけで運用していた
/// 環境で、dynamic フィールドの有無に依存して team が立ち上がらないのを防ぐ)。
///
/// `tokio::fs::read` を使うので state.lock を保持中に呼ばないこと (deadlock はしないが
/// blocking I/O で hub の lock holder time が伸びるため)。
async fn load_persisted_dynamic_for_team(
    team_id: &str,
) -> Vec<crate::team_hub::protocol::dynamic_role::PersistedDynamicRoleEntry> {
    if team_id.trim().is_empty() {
        return Vec::new();
    }
    let path = crate::util::config_paths::role_profiles_path();
    let bytes = match tokio::fs::read(&path).await {
        Ok(b) => b,
        Err(_) => return Vec::new(), // file 不在は normal (初回起動 / 動的ロールを使わない運用)
    };
    let value: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(
                "[register_team] role-profiles.json parse failed when loading dynamic[]: {e}"
            );
            return Vec::new();
        }
    };
    let Some(arr) = value.get("dynamic").and_then(|v| v.as_array()) else {
        // 古い JSON (dynamic フィールドなし) は no-op で OK。新規 save 時に renderer が追加する。
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in arr {
        let entry: crate::team_hub::protocol::dynamic_role::PersistedDynamicRoleEntry =
            match serde_json::from_value(item.clone()) {
                Ok(e) => e,
                Err(e) => {
                    tracing::warn!("[register_team] skipping malformed dynamic[] entry: {e}");
                    continue;
                }
            };
        if entry.team_id == team_id {
            out.push(entry);
        }
    }
    out
}

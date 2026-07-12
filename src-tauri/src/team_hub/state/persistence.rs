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
    pub async fn register_team(
        &self,
        team_id: &str,
        name: &str,
        project_root: Option<&str>,
        members: &[(String, String)],
    ) -> Result<(), String> {
        if team_id.is_empty() || team_id == "_init" {
            return Ok(());
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
        // Issue #1193: `team_id` は renderer 由来であり、同じ ID を別 project から
        // register して既存 TeamInfo の project_root を上書きしてはならない。判定と
        // 登録を同じ lock 内で行い、TOCTOU を作らない。
        if let (Some(requested_root), Some(existing)) = (
            project_root.map(str::trim).filter(|root| !root.is_empty()),
            s.teams.get(team_id),
        ) {
            if existing.project_root.as_deref() != Some(requested_root) {
                return Err("team_id is already owned by another project".to_string());
            }
        }
        s.active_teams.insert(team_id.to_string());
        // Issue #800: Canvas spawn 由来の初代 member (leader / worker) は
        // `team_recruit` / `team_create_leader` の recruit grant 経路を通らないため、
        // team 登録時に `(team_id, agent_id) -> role` の binding を事前 seed する。
        // これで `resolve_pending_recruit` が既存 binding 経路でこれらの handshake を
        // 許可する (#742 の binding 強制で初代 member が全 reject される回帰の修正)。
        // `or_insert_with` で、handshake 成功や別経路で既に確立済みの binding は上書きしない。
        //
        // PR #805 review: `members` は renderer 由来のため、無検証で seed すると #742 の
        // handshake binding 強制を任意入力で満たせてしまう。Canvas spawn の member id は
        // `<role>-<n>-team-<teamId>` 形式で team_id を suffix に内包するので、team_id を
        // suffix に持たない agent_id は別 team / 不正入力とみなして seed しない
        // (= 事前 seed する binding を必ず当該 team scope に閉じる)。
        for (agent_id, role) in members {
            if agent_id.trim().is_empty() || role.trim().is_empty() {
                continue;
            }
            if !agent_id.ends_with(team_id) {
                tracing::warn!(
                    team_id = %team_id,
                    agent_id = %agent_id,
                    "[teamhub] register_team: agent_id が team scope 外のため binding seed をスキップ"
                );
                continue;
            }
            // Issue #934: seed は AgentEntry の遷移メソッド経由 (Active 済みは上書きしない)。
            s.seed_role_binding(team_id, agent_id, role);
        }
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
        // Issue #1071: tasks/reports と同じ restore 経路で message 列/既読/next_message_id を復元 (lock 再取得のため drop 後)。
        self.restore_team_messages(team_id).await;
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
        Ok(())
    }

    /// チームを active list から外す。戻り値が true なら active が 0 → MCP 設定削除可
    pub async fn clear_team_for_project(
        &self,
        team_id: &str,
        project_root: &str,
    ) -> Result<bool, String> {
        let mut s = self.state.lock().await;
        let Some(existing) = s.teams.get(team_id) else {
            // 未登録 ID に対して global MCP 設定を消す方向へ倒さない。
            return Ok(false);
        };
        if existing.project_root.as_deref() != Some(project_root) {
            return Err("team_id is not owned by the active project".to_string());
        }
        s.teams.remove(team_id);
        s.active_teams.remove(team_id);
        // 動的ロールもチーム単位でクリア (チーム破棄でロール定義を残す意味は無い)
        s.dynamic_roles.remove(team_id);

        // Issue #829 → #934: team scope に紐付く in-memory state を漏れなく解放する。
        // 旧実装は agent 状態が 4 並行 map に分散していたため「binding 逆引きで届かない
        // agent の diagnostics が leak する」(#829) → 「掃除用 roster map を足す」という
        // メタな対症療法を重ねていた。AgentEntry 統合後は agent 状態が
        // `agents: HashMap<(team_id, agent_id), AgentEntry>` の 1 map に閉じるため、
        // teardown は team prefix の retain 一発で完結し、cross-team 共有 agent も
        // per-team entry なので他 team を巻き込まない (防御コードという概念ごと消える)。

        // (1) team_id 単体を key に持つ recruit 直列化 semaphore。
        s.recruit_semaphores.remove(team_id);

        // (2) agent ライフサイクル state (role binding / diagnostics / status rate limit) を一括除去。
        s.remove_team_agents(team_id);

        // (3) (team_id, *) を key に持つ advisory file lock も retain で一括除去。
        s.file_locks.retain(|(tid, _), _| tid != team_id);

        Ok(s.active_teams.is_empty())
    }

    /// owner を持たないユニットテスト用の teardown。production IPC は必ず
    /// `clear_team_for_project` を使い、renderer がこの bypass に到達する経路はない。
    #[cfg(test)]
    pub async fn clear_team(&self, team_id: &str) -> bool {
        let mut s = self.state.lock().await;
        s.teams.remove(team_id);
        s.active_teams.remove(team_id);
        s.dynamic_roles.remove(team_id);
        s.recruit_semaphores.remove(team_id);
        s.remove_team_agents(team_id);
        s.file_locks.retain(|(tid, _), _| tid != team_id);
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

    /// renderer IPC 用の leader 切替。未登録 team を暗黙に作成せず、active project が
    /// 登録時の owner と一致する場合だけ許可する。MCP protocol 内部はすでに
    /// `RequestContext.team_id` で scope 済みなので、従来の `set_active_leader` を使う。
    pub async fn set_active_leader_for_project(
        &self,
        team_id: &str,
        project_root: &str,
        agent_id: Option<String>,
    ) -> Result<(), String> {
        if team_id.trim().is_empty() {
            return Err("team_id is required".to_string());
        }
        {
            let s = self.state.lock().await;
            let Some(team) = s.teams.get(team_id) else {
                return Err("team_id is not registered".to_string());
            };
            if team.project_root.as_deref() != Some(project_root) {
                return Err("team_id is not owned by the active project".to_string());
            }
        }
        self.set_active_leader(team_id, agent_id).await;
        Ok(())
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
    // Issue #936: 旧実装は parse 失敗時に warn だけ出して空配列で続行し、破損 role-profiles.json
    // を退避していなかった。共通ヘルパ経由にして「default (空) に倒す前に原本を退避」する。
    // 退避は主オーナー role_profiles_load と同じ write_timestamped_backup・0o600 規約で、コピー
    // 退避ゆえ並行 role_profiles_save の valid file を巻き込まない。
    let value: serde_json::Value =
        match crate::commands::safe_load::safe_load_or_quarantine(&path, Some(0o600)).await {
            crate::commands::safe_load::LoadOutcome::Loaded(v) => v,
            // 不在は normal (初回起動 / 動的ロール未使用)。破損は退避済みなので空で続行。
            crate::commands::safe_load::LoadOutcome::Absent
            | crate::commands::safe_load::LoadOutcome::Corrupted => return Vec::new(),
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

#[cfg(test)]
#[path = "persistence/tests.rs"]
mod tests;

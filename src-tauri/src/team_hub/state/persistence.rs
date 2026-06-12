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
    ) {
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

/// Issue #800: `register_team` が team member の `agent_role_bindings` を seed することの単体テスト。
///
/// PR #742 (Security) で handshake が「Hub 発行の recruit grant か既存 binding が必須」に
/// 強化された結果、Canvas の team spawn で renderer が直接生成する初代 leader / worker
/// (`leader-0-team-<id>` / `worker-N-team-<id>` 形式) が grant 経路を通らず全 reject される
/// 回帰が発生した。`register_team` が member の binding を事前 seed することで、
/// `resolve_pending_recruit` が既存 binding 経路でこれらを許可することを検証する。
#[cfg(test)]
mod register_team_binding_seed_tests {
    use crate::pty::SessionRegistry;
    use crate::team_hub::TeamHub;
    use std::sync::Arc;

    fn make_hub() -> TeamHub {
        TeamHub::new(Arc::new(SessionRegistry::new()))
    }

    /// `register_team` で seed された team member は、recruit grant が無くても
    /// handshake (`resolve_pending_recruit`) を通る。leader / worker いずれも対象。
    #[tokio::test]
    async fn register_team_seeds_member_bindings_so_handshake_passes_without_grant() {
        let hub = make_hub();
        let team_id = "team-800";
        let members = [
            ("leader-0-team-800".to_string(), "leader".to_string()),
            ("worker-1-team-800".to_string(), "programmer".to_string()),
        ];
        hub.register_team(team_id, "Team 800", None, &members).await;

        assert!(
            hub.resolve_pending_recruit("leader-0-team-800", team_id, "leader")
                .await,
            "seeded leader should pass handshake without a recruit grant"
        );
        assert!(
            hub.resolve_pending_recruit("worker-1-team-800", team_id, "programmer")
                .await,
            "seeded worker should pass handshake without a recruit grant"
        );
    }

    /// PR #805 review: `team_id` を suffix に持たない (= 別 team / 不正な) agent_id は
    /// binding seed されず handshake も通らない。renderer 入力で任意の binding を
    /// 注入できないこと (#742 の binding 強制が後退しないこと) を検証する。
    #[tokio::test]
    async fn register_team_skips_member_agent_id_outside_team_scope() {
        let hub = make_hub();
        let team_id = "team-805";
        let members = [
            ("leader-0-team-805".to_string(), "leader".to_string()),
            // team-805 を suffix に持たない別 team scope の agent_id。
            ("worker-9-team-other".to_string(), "programmer".to_string()),
        ];
        hub.register_team(team_id, "Team 805", None, &members).await;

        assert!(
            hub.resolve_pending_recruit("leader-0-team-805", team_id, "leader")
                .await,
            "team scope 内の leader は seed され handshake を通る"
        );
        assert!(
            !hub.resolve_pending_recruit("worker-9-team-other", team_id, "programmer")
                .await,
            "team scope 外の agent_id は seed されず handshake は通らない"
        );
    }
}

/// Issue #829: `clear_team` が team scope の全 in-memory state を漏れなく解放することの単体テスト。
///
/// 旧実装は `teams` / `active_teams` / `dynamic_roles` の 3 つしか掃除せず、
/// `recruit_semaphores` / `file_locks` / `agent_role_bindings` / `member_diagnostics` /
/// `last_status_call_at` が破棄済みチーム分も残り続け、長時間運用で in-memory state が
/// 単調増加していた (= メモリリーク)。
#[cfg(test)]
mod clear_team_release_tests {
    use crate::pty::SessionRegistry;
    use crate::team_hub::{TeamHub, TeamInfo};
    use std::sync::Arc;
    use std::time::Instant;
    use tokio::sync::Semaphore;

    fn make_hub() -> TeamHub {
        TeamHub::new(Arc::new(SessionRegistry::new()))
    }

    /// `clear_team` は破棄対象 team scope の recruit_semaphores / file_locks /
    /// AgentEntry (role binding / diagnostics / status rate limit) を全て解放し、
    /// 別 team の同種 state は保持する (Issue #829 → #934)。
    #[tokio::test]
    async fn clear_team_releases_all_team_scoped_state() {
        let hub = make_hub();
        let team_a = "team-829-a";
        let agent_a = "vc-829-a";
        let team_b = "team-829-b";
        let agent_b = "vc-829-b";

        // 両 team に AgentEntry (binding + diagnostics + status timestamp) / semaphore を仕込む。
        {
            let mut s = hub.state.lock().await;
            s.teams
                .entry(team_a.to_string())
                .or_insert_with(TeamInfo::default);
            s.active_teams.insert(team_a.to_string());
            s.teams
                .entry(team_b.to_string())
                .or_insert_with(TeamInfo::default);
            s.active_teams.insert(team_b.to_string());

            s.seed_role_binding(team_a, agent_a, "programmer");
            s.seed_role_binding(team_b, agent_b, "programmer");
            s.agent_entry_mut(team_a, agent_a).last_status_call_at = Some(Instant::now());
            s.agent_entry_mut(team_b, agent_b).last_status_call_at = Some(Instant::now());

            s.recruit_semaphores
                .insert(team_a.to_string(), Arc::new(Semaphore::new(1)));
            s.recruit_semaphores
                .insert(team_b.to_string(), Arc::new(Semaphore::new(1)));
        }

        // file lock は public method 経由で取得する (内部で state.lock するのでガード保持外で呼ぶ)。
        hub.try_acquire_file_locks_with_cap(
            team_a,
            agent_a,
            "programmer",
            &["src/a.rs".to_string()],
            16,
        )
        .await
        .expect("team_a lock acquire");
        hub.try_acquire_file_locks_with_cap(
            team_b,
            agent_b,
            "programmer",
            &["src/b.rs".to_string()],
            16,
        )
        .await
        .expect("team_b lock acquire");

        // 破棄前の前提条件 (team_a 側が確かに積まれている)。
        {
            let s = hub.state.lock().await;
            assert!(s.recruit_semaphores.contains_key(team_a));
            assert!(s.agent_entry(team_a, agent_a).is_some());
            assert_eq!(s.bound_role(team_a, agent_a).as_deref(), Some("programmer"));
            assert!(s
                .file_locks
                .contains_key(&(team_a.to_string(), "src/a.rs".to_string())));
        }

        // team_a を破棄。team_b がまだ active なので戻り値は false。
        let active_empty = hub.clear_team(team_a).await;
        assert!(!active_empty, "team_b がまだ active なので false のはず");

        let s = hub.state.lock().await;
        // team_a 由来の state は全て解放されている (leak していないこと)。
        assert!(!s.teams.contains_key(team_a));
        assert!(!s.active_teams.contains(team_a));
        assert!(
            !s.recruit_semaphores.contains_key(team_a),
            "recruit_semaphores leak"
        );
        assert!(
            s.agent_entry(team_a, agent_a).is_none(),
            "AgentEntry (diagnostics / binding / status rate limit) leak"
        );
        assert!(
            !s.file_locks
                .contains_key(&(team_a.to_string(), "src/a.rs".to_string())),
            "file_locks leak"
        );

        // team_b 由来の state は一切影響を受けない。
        assert!(s.teams.contains_key(team_b));
        assert!(s.recruit_semaphores.contains_key(team_b));
        let entry_b = s.agent_entry(team_b, agent_b).expect("team_b entry survives");
        assert_eq!(entry_b.active_role(), Some("programmer"));
        assert!(entry_b.last_status_call_at.is_some());
        assert!(s
            .file_locks
            .contains_key(&(team_b.to_string(), "src/b.rs".to_string())));
    }

    /// 同一 agent_id が複数 team に在籍している (実運用では稀) 場合、entry は
    /// `(team_id, agent_id)` で per-team に分離されているため、破棄した team 以外の
    /// entry (diagnostics / binding) は影響を受けない。
    /// 旧実装 (agent_id 単独キー + roster 逆引き防御) の cross-team 防御コードは
    /// per-team entry 化で概念ごと不要になった (Issue #934)。
    #[tokio::test]
    async fn clear_team_keeps_other_team_entry_for_shared_agent() {
        let hub = make_hub();
        let team_a = "team-829-shared-a";
        let team_b = "team-829-shared-b";
        let shared_agent = "vc-shared";
        {
            let mut s = hub.state.lock().await;
            s.teams
                .entry(team_a.to_string())
                .or_insert_with(TeamInfo::default);
            s.active_teams.insert(team_a.to_string());
            s.teams
                .entry(team_b.to_string())
                .or_insert_with(TeamInfo::default);
            s.active_teams.insert(team_b.to_string());
            // 同一 agent_id を両 team に bind (per-team entry が 2 つできる)。
            s.seed_role_binding(team_a, shared_agent, "programmer");
            s.seed_role_binding(team_b, shared_agent, "programmer");
            s.agent_entry_mut(team_b, shared_agent).last_status_call_at = Some(Instant::now());
        }

        hub.clear_team(team_a).await;

        let s = hub.state.lock().await;
        // team_a の entry は消えるが、team_b の entry (binding / diagnostics) は残る。
        assert!(s.agent_entry(team_a, shared_agent).is_none());
        let entry_b = s
            .agent_entry(team_b, shared_agent)
            .expect("shared agent entry for team_b must survive");
        assert_eq!(entry_b.active_role(), Some("programmer"));
        assert!(entry_b.last_status_call_at.is_some());
    }

    /// Issue #829 (旧支配的経路の回帰テスト) → #934:
    /// recruit grant で entry を生やした agent が、`clear_team` より **先に**
    /// dismiss / record_agent_process_exit で role binding を失効する (= teardown 前に
    /// exit/dismiss されるという通常運用) ケース。旧実装は agent-keyed map を binding の
    /// 逆引きでしか掃除できず永久 leak していた (#829 は roster 追加で対症療法)。
    /// AgentEntry 統合後は binding 失効が Active → Exited の遷移になり (entry は診断保持の
    /// ため残る)、clear_team の team prefix retain が entry ごと回収する。
    /// production の挿入経路 (`try_register_pending_recruit` → handshake) と失効経路
    /// (`remove_agent_role_binding` = dismiss / 終了が呼ぶ glue) を使って実運用を忠実に再現する。
    #[tokio::test]
    async fn clear_team_reclaims_entry_when_binding_retired_before_teardown() {
        let hub = make_hub();
        let team_id = "team-829-orphan";
        let agent_id = "vc-829-orphan";

        s_register_active_team(&hub, team_id).await;

        // (1) recruit grant: AgentEntry (Granted) を挿入する production 経路。
        hub.try_register_pending_recruit(
            agent_id.to_string(),
            team_id.to_string(),
            "programmer".to_string(),
            "leader-orphan".to_string(),
            false,
            &[],
        )
        .await
        .expect("pending recruit grant should be registered");

        // handshake 成立で Granted → Active{role} へ遷移した状態を再現。
        assert!(
            hub.resolve_pending_recruit(agent_id, team_id, "programmer")
                .await,
            "handshake should succeed for the granted recruit"
        );

        // team_status 呼び出し相当で last_status_call_at にも値を生やす。
        {
            let mut s = hub.state.lock().await;
            s.agent_entry_mut(team_id, agent_id).last_status_call_at = Some(Instant::now());
        }

        // 前提: entry が Active で diagnostics / last_status も積まれている。
        {
            let s = hub.state.lock().await;
            let entry = s.agent_entry(team_id, agent_id).expect("entry exists");
            assert_eq!(entry.active_role(), Some("programmer"));
            assert!(entry.last_status_call_at.is_some());
            assert!(!entry.diagnostics.recruited_at.is_empty());
        }

        // (2) clear_team **より先に** binding を失効 = 通常運用 (dismiss /
        // record_agent_process_exit)。remove_agent_role_binding は dismiss と
        // record_agent_process_exit が共有する production の失効経路。
        assert!(
            hub.remove_agent_role_binding(team_id, agent_id).await,
            "binding should exist and be retired before teardown"
        );
        {
            let s = hub.state.lock().await;
            let entry = s.agent_entry(team_id, agent_id).expect("entry survives retire");
            // binding (Active) は失効したが entry は診断保持のため残る。
            assert_eq!(entry.active_role(), None);
        }

        // (3) teardown。
        hub.clear_team(team_id).await;

        let s = hub.state.lock().await;
        // 修正後: team prefix retain が entry ごと回収する (掃除漏れの余地が無い)。
        assert!(
            s.agent_entry(team_id, agent_id).is_none(),
            "AgentEntry must be reclaimed even though the binding was retired before clear_team"
        );
        assert!(
            !s.agents.keys().any(|(tid, _)| tid == team_id),
            "no agent entry for the cleared team may remain"
        );
    }

    /// テスト用ヘルパ: 指定 team を active として登録する。
    async fn s_register_active_team(hub: &TeamHub, team_id: &str) {
        let mut s = hub.state.lock().await;
        s.teams
            .entry(team_id.to_string())
            .or_insert_with(TeamInfo::default);
        s.active_teams.insert(team_id.to_string());
    }
}

//! `persistence.rs` の unit test 本体。file-size ratchet (Issue #939) のため実装本体と
//! 分離して配置する。テストは `TeamHub` の公開 API 経由で検証する。

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
        hub.register_team(team_id, "Team 800", None, &members)
            .await
            .unwrap();

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
        hub.register_team(team_id, "Team 805", None, &members)
            .await
            .unwrap();

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

    #[tokio::test]
    async fn team_id_cannot_be_rebound_or_cleared_from_another_project() {
        let hub = make_hub();
        let owner = tempfile::tempdir().unwrap();
        let foreign = tempfile::tempdir().unwrap();
        let owner_root = owner.path().to_string_lossy().into_owned();
        let foreign_root = foreign.path().to_string_lossy().into_owned();
        let team_id = "team-1193-owner";

        hub.register_team(team_id, "Owner", Some(&owner_root), &[])
            .await
            .unwrap();
        assert!(hub
            .register_team(team_id, "Foreign", Some(&foreign_root), &[])
            .await
            .is_err());
        assert!(hub
            .set_active_leader_for_project(team_id, &foreign_root, Some("leader-foreign".into()))
            .await
            .is_err());
        assert!(hub
            .clear_team_for_project(team_id, &foreign_root)
            .await
            .is_err());

        {
            let state = hub.state.lock().await;
            let team = state.teams.get(team_id).expect("owner team remains registered");
            assert_eq!(team.project_root.as_deref(), Some(owner_root.as_str()));
            assert_eq!(team.name, "Owner");
            assert!(team.active_leader_agent_id.is_none());
        }

        assert!(hub
            .clear_team_for_project(team_id, &owner_root)
            .await
            .unwrap());
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
        let entry_b = s
            .agent_entry(team_b, agent_b)
            .expect("team_b entry survives");
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
            let entry = s
                .agent_entry(team_id, agent_id)
                .expect("entry survives retire");
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

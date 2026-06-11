//! Issue #934: agent ライフサイクルの型付き状態 (`AgentEntry` / `AgentPhase`)。
//!
//! 旧実装は agent 1 体の状態が **4 本の平行 map** に分散していた:
//!   - `agent_role_bindings: HashMap<(team_id, agent_id), role>` (#183/#637)
//!   - `member_diagnostics: HashMap<agent_id, MemberDiagnostics>` (#342)
//!   - `last_status_call_at: HashMap<agent_id, Instant>` (#634)
//!   - `team_agent_roster: HashMap<team_id, HashSet<agent_id>>` (#829 — 「掃除し漏れたから
//!     掃除用の map をもう 1 個足す」というメタな対症療法)
//!
//! 状態遷移の不変条件はどの型にも強制されず、teardown 経路 (dismiss / process exit /
//! recruit timeout / clear_team) ごとに全 map を手動同期する規約頼みになっていたため、
//! 掃除漏れ (#829) や binding 上書き race (#637)、採用系の故障 (#753/#800/#811/#858/#863)
//! が「毎回別の顔」で顕在化していた。
//!
//! 本 module はこれらを `agents: HashMap<(team_id, agent_id), AgentEntry>` に統合する:
//!   - **roster は entry の存在そのもの** (専用 map を持たない)
//!   - **teardown は entry の remove 一回** で完結する
//!   - **clear_team は team prefix の retain 一発** になり、cross-team 共有 agent も
//!     per-team entry なので他 team を巻き込まない (旧実装の「他 roster を逆引きして
//!     残すか判断する」防御コードが概念ごと消える)
//!   - 遷移は `AgentEntry` のメソッド経由のみ。不正遷移 (Active な role の上書き) は
//!     構造化エラーになる
//!
//! ## 設計ノート: pending_recruits との関係
//!
//! recruit の in-flight transport (handshake / ack の oneshot channel、grace window の
//! `timed_out_at`) は引き続き `pending_recruits` が持つ。channel は `Send` 待機側に move
//! する必要があり、状態 snapshot とは寿命が異なるため entry に畳み込まない。
//! `pending_recruits` の entry は **必ず `AgentPhase::Granted` の期間にのみ存在する**
//! (grant 発行で両方に挿入され、handshake 成功 / timeout 掃除で両方から消える) という
//! 対応関係を保つ。

use std::collections::HashMap;
use std::time::Instant;

use super::hub_state::HubState;
use super::member_diagnostics::MemberDiagnostics;

/// agent の一生 (recruit grant → handshake → 稼働 → 退出) の型付き表現。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum AgentPhase {
    /// recruit grant 発行済みで handshake 待ち (#742 の TTL / single-use は
    /// `pending_recruits` 側の `issued_at` で検証される)。
    Granted,
    /// handshake 完了。`role` が bind 済みで、別 role を主張する再 handshake は拒否される
    /// (#183 の role 偽装防止 / #637 の cross-team 上書き race 遮断の正本)。
    Active { role: String },
    /// 稼働後に退出した (process exit / dismiss)。診断 (last_exit_*) を postmortem 用に
    /// 保持するため entry 自体は clear_team まで残すが、role binding は失効しており
    /// 再接続には新しい recruit grant が必要。
    Exited,
}

#[derive(Clone, Debug)]
pub(crate) struct AgentEntry {
    pub phase: AgentPhase,
    pub diagnostics: MemberDiagnostics,
    /// Issue #634: `team_status` rate limit 用の最終呼び出し時刻。
    pub last_status_call_at: Option<Instant>,
}

impl AgentEntry {
    pub(crate) fn granted(recruited_at: String) -> Self {
        Self {
            phase: AgentPhase::Granted,
            diagnostics: MemberDiagnostics {
                recruited_at,
                ..MemberDiagnostics::default()
            },
            last_status_call_at: None,
        }
    }

    /// 現在 Active なら bind 済み role を返す。
    pub(crate) fn active_role(&self) -> Option<&str> {
        match &self.phase {
            AgentPhase::Active { role } => Some(role),
            _ => None,
        }
    }
}

/// `(team_id, agent_id)` キーの owned tuple を作る。
fn key(team_id: &str, agent_id: &str) -> (String, String) {
    (team_id.to_string(), agent_id.to_string())
}

impl HubState {
    /// entry を取得 (無ければ `Granted` で作成) して返す。
    ///
    /// 診断更新系 (`team_send` / `team_read` / PTY observer 等) は「entry が無い agent」
    /// (register_team seed 前のレガシー経路など) からも呼ばれうるため、欠損時は
    /// 最小限の Granted entry を起こして記録を落とさない。
    pub(crate) fn agent_entry_mut(&mut self, team_id: &str, agent_id: &str) -> &mut AgentEntry {
        self.agents
            .entry(key(team_id, agent_id))
            .or_insert_with(|| AgentEntry::granted(chrono::Utc::now().to_rfc3339()))
    }

    pub(crate) fn agent_entry(&self, team_id: &str, agent_id: &str) -> Option<&AgentEntry> {
        self.agents.get(&key(team_id, agent_id))
    }

    /// 診断の可変参照 (entry が無ければ作成)。旧 `member_diagnostics.entry(..).or_default()`。
    pub(crate) fn diagnostics_mut(
        &mut self,
        team_id: &str,
        agent_id: &str,
    ) -> &mut MemberDiagnostics {
        &mut self.agent_entry_mut(team_id, agent_id).diagnostics
    }

    /// handshake 済み role (旧 `agent_role_bindings.get(&(team, agent))`)。
    pub(crate) fn bound_role(&self, team_id: &str, agent_id: &str) -> Option<String> {
        self.agent_entry(team_id, agent_id)
            .and_then(|e| e.active_role().map(str::to_string))
    }

    /// handshake 成功時の遷移: `Granted` / 新規 → `Active { role }`。
    ///
    /// 既に `Active` で **異なる** role が bind 済みなら `Err` (旧実装の「binding 不一致で
    /// 接続切断」と同じ判定を、遷移メソッド側で構造的に強制する)。同一 role の再 handshake
    /// (再接続) は no-op で `Ok`。`Exited` からの直接復帰は新 grant 経由のみ許す設計だが、
    /// grant 検証は呼び出し側 (`resolve_pending_recruit`) の pending 照合が担うため、
    /// ここでは `Active` へ遷移させる。
    pub(crate) fn bind_role(
        &mut self,
        team_id: &str,
        agent_id: &str,
        role: &str,
    ) -> Result<(), String> {
        let entry = self.agent_entry_mut(team_id, agent_id);
        match &entry.phase {
            AgentPhase::Active { role: bound } if bound != role => Err(format!(
                "agent '{agent_id}' is already bound to role '{bound}' in this team (refusing '{role}')"
            )),
            _ => {
                entry.phase = AgentPhase::Active {
                    role: role.to_string(),
                };
                Ok(())
            }
        }
    }

    /// register_team の事前 seed (旧 `agent_role_bindings.entry(..).or_insert_with(..)`):
    /// 既に Active な entry は上書きしない。
    pub(crate) fn seed_role_binding(&mut self, team_id: &str, agent_id: &str, role: &str) {
        let entry = self.agent_entry_mut(team_id, agent_id);
        if !matches!(entry.phase, AgentPhase::Active { .. }) {
            entry.phase = AgentPhase::Active {
                role: role.to_string(),
            };
        }
    }

    /// dismiss / process exit の遷移: role binding を失効させ `Exited` へ。
    /// 診断は postmortem 用に entry ごと保持する (掃除は clear_team の retain 一発)。
    /// 戻り値は「Active な binding が実際に失効したか」(旧 `remove(..).is_some()` 互換)。
    pub(crate) fn retire_agent(&mut self, team_id: &str, agent_id: &str) -> bool {
        match self.agents.get_mut(&key(team_id, agent_id)) {
            Some(entry) => {
                let was_active = matches!(entry.phase, AgentPhase::Active { .. });
                entry.phase = AgentPhase::Exited;
                was_active
            }
            None => false,
        }
    }

    /// 当該 team の handshake 済みメンバー (agent_id, role) 一覧 (旧 binding の team filter)。
    pub(crate) fn team_member_roles(&self, team_id: &str) -> Vec<(String, String)> {
        self.agents
            .iter()
            .filter(|((tid, _), _)| tid == team_id)
            .filter_map(|((_, aid), e)| e.active_role().map(|r| (aid.clone(), r.to_string())))
            .collect()
    }

    /// clear_team 用: 当該 team の entry を一括除去する (Issue #934 の本丸)。
    /// per-team entry なので cross-team 共有 agent の他 team entry は影響を受けない。
    pub(crate) fn remove_team_agents(&mut self, team_id: &str) {
        self.agents.retain(|(tid, _), _| tid != team_id);
    }
}

/// `HubState::agents` の型 alias (hub_state.rs のフィールド宣言用)。
pub(crate) type AgentMap = HashMap<(String, String), AgentEntry>;

#[cfg(test)]
mod agent_phase_tests {
    use super::*;
    use crate::pty::SessionRegistry;
    use crate::team_hub::TeamHub;
    use std::sync::Arc;

    fn make_hub() -> TeamHub {
        TeamHub::new(Arc::new(SessionRegistry::new()))
    }

    #[tokio::test]
    async fn bind_role_transitions_granted_to_active_and_rejects_mismatch() {
        let hub = make_hub();
        let mut s = hub.state.lock().await;
        // Granted → Active
        s.agents.insert(
            ("t1".into(), "a1".into()),
            AgentEntry::granted("2026-06-11T00:00:00Z".into()),
        );
        assert!(s.bind_role("t1", "a1", "programmer").is_ok());
        assert_eq!(s.bound_role("t1", "a1").as_deref(), Some("programmer"));
        // 同 role の再 handshake (再接続) は no-op で Ok
        assert!(s.bind_role("t1", "a1", "programmer").is_ok());
        // 異なる role の主張は構造化エラー (#183 の role 偽装防止)
        let err = s.bind_role("t1", "a1", "reviewer").unwrap_err();
        assert!(err.contains("already bound"), "unexpected error: {err}");
        assert_eq!(
            s.bound_role("t1", "a1").as_deref(),
            Some("programmer"),
            "失敗した遷移は状態を変えない"
        );
    }

    #[tokio::test]
    async fn retire_agent_keeps_diagnostics_until_clear_team() {
        let hub = make_hub();
        let mut s = hub.state.lock().await;
        s.seed_role_binding("t1", "a1", "programmer");
        s.diagnostics_mut("t1", "a1").last_exit_code = Some(0);
        // Active → Exited (binding 失効、戻り値 true)
        assert!(s.retire_agent("t1", "a1"));
        assert_eq!(s.bound_role("t1", "a1"), None);
        // 診断は postmortem 用に残る
        assert_eq!(
            s.agent_entry("t1", "a1").unwrap().diagnostics.last_exit_code,
            Some(0)
        );
        // idempotent: 既に Exited なら false (旧 remove(..).is_some() 互換)
        assert!(!s.retire_agent("t1", "a1"));
        // 存在しない entry も false
        assert!(!s.retire_agent("t1", "missing"));
        // clear_team 相当の retain で entry ごと回収される
        s.remove_team_agents("t1");
        assert!(s.agent_entry("t1", "a1").is_none());
    }

    #[tokio::test]
    async fn seed_role_binding_does_not_overwrite_active() {
        let hub = make_hub();
        let mut s = hub.state.lock().await;
        s.bind_role("t1", "a1", "programmer").unwrap();
        // register_team の事前 seed は handshake 済み binding を上書きしない
        s.seed_role_binding("t1", "a1", "reviewer");
        assert_eq!(s.bound_role("t1", "a1").as_deref(), Some("programmer"));
        // Exited な entry への seed は再 bind を許す (canvas restore の再登録経路)
        s.retire_agent("t1", "a1");
        s.seed_role_binding("t1", "a1", "reviewer");
        assert_eq!(s.bound_role("t1", "a1").as_deref(), Some("reviewer"));
    }

    #[tokio::test]
    async fn team_member_roles_lists_only_active_entries_of_that_team() {
        let hub = make_hub();
        let mut s = hub.state.lock().await;
        s.bind_role("t1", "a1", "programmer").unwrap();
        s.bind_role("t1", "a2", "reviewer").unwrap();
        s.bind_role("t2", "a3", "leader").unwrap();
        // Granted (未 handshake) は member に数えない
        s.agents.insert(
            ("t1".into(), "a4".into()),
            AgentEntry::granted("2026-06-11T00:00:00Z".into()),
        );
        // Exited も数えない
        s.bind_role("t1", "a5", "hr").unwrap();
        s.retire_agent("t1", "a5");

        let mut roles = s.team_member_roles("t1");
        roles.sort();
        assert_eq!(
            roles,
            vec![
                ("a1".to_string(), "programmer".to_string()),
                ("a2".to_string(), "reviewer".to_string())
            ]
        );
    }
}

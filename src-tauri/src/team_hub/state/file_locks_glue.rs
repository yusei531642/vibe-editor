//! `HubState` の `file_locks` / `dynamic_roles` / engine policy / role profile summary を
//! `TeamHub` メソッド越しに操作する glue 層。
//!
//! Issue #736: 旧 `state.rs` から「file_locks ヘルパ + dynamic role + engine policy」を切り出し。

use crate::team_hub::TeamHub;

use super::hub_state::{DynamicRole, EnginePolicy, RoleProfileSummary, TeamInfo};

impl TeamHub {
    // ===== Issue #526: file lock helpers (TeamHub method 経由で HubState の file_locks を操作) =====

    /// Issue #599 (Tier A-1): team あたりの lock 数 cap を atomic に enforce しつつ acquire する。
    /// HubState の Mutex を 1 セッションだけ取って count → cap check → try_acquire を完結させる
    /// (= count と insert の間に別 agent が割り込んで cap を踏み越える race を排除)。
    pub async fn try_acquire_file_locks_with_cap(
        &self,
        team_id: &str,
        agent_id: &str,
        role: &str,
        paths: &[String],
        cap: usize,
    ) -> Result<crate::team_hub::file_locks::LockResult, crate::team_hub::file_locks::FileLockCapExceeded>
    {
        let mut s = self.state.lock().await;
        crate::team_hub::file_locks::try_acquire_with_cap(
            &mut s.file_locks,
            team_id,
            agent_id,
            role,
            paths,
            cap,
        )
    }

    /// `paths` のうち自分が保持するロックを解放する。
    pub async fn release_file_locks(
        &self,
        team_id: &str,
        agent_id: &str,
        paths: &[String],
    ) -> crate::team_hub::file_locks::UnlockResult {
        let mut s = self.state.lock().await;
        crate::team_hub::file_locks::release(&mut s.file_locks, team_id, agent_id, paths)
    }

    /// 指定 agent が team 内で保持する全 lock を解放する。`team_dismiss` 時に呼ぶ想定。
    pub async fn release_all_file_locks_for_agent(&self, team_id: &str, agent_id: &str) -> u32 {
        let mut s = self.state.lock().await;
        crate::team_hub::file_locks::release_all_for_agent(&mut s.file_locks, team_id, agent_id)
    }

    /// Issue #637: dismiss された (team_id, agent_id) の role binding を取り除く。
    /// 取り除かないと「dismiss 済 worker の role 文字列」がメモリに残り続け、
    /// 同 agent_id を別 role で再 recruit したい時に role mismatch で接続拒否される。
    /// 別 team の binding は team_id 次元で分離されているので影響しない。
    pub async fn remove_agent_role_binding(&self, team_id: &str, agent_id: &str) -> bool {
        let mut s = self.state.lock().await;
        s.agent_role_bindings
            .remove(&(team_id.to_string(), agent_id.to_string()))
            .is_some()
    }

    /// `paths` の現在の lock 保持者一覧 (assign_task の競合検知用、agent_id_filter で自分宛除外可)。
    pub async fn peek_file_locks(
        &self,
        team_id: &str,
        agent_id_filter: Option<&str>,
        paths: &[String],
    ) -> Vec<crate::team_hub::file_locks::LockConflict> {
        let s = self.state.lock().await;
        crate::team_hub::file_locks::peek(&s.file_locks, team_id, agent_id_filter, paths)
    }

    /// team 内の全 lock 一覧を返す。`file_locks::list_for_team` (pure 関数 + 単体テストあり) を
    /// HubState の Mutex 越しに呼ぶ glue。
    ///
    /// Issue #739: 現状 production の呼び出し元は無いが、`#[allow(dead_code)]` を残す:
    /// 依存先の `file_locks::list_for_team` は `file_locks` モジュールの公開 API 一覧に
    /// 明記され単体テストも持つ「意図された primitive」であり、この glue が唯一の production
    /// 配線ポイント。glue ごと削除すると `list_for_team` が連鎖的に dead code 化する。
    /// team_diagnostics の lock 一覧 UI が実装され次第、本 method を配線して attr を外す。
    #[allow(dead_code)]
    pub async fn list_file_locks_for_team(
        &self,
        team_id: &str,
    ) -> Vec<crate::team_hub::file_locks::FileLock> {
        let s = self.state.lock().await;
        crate::team_hub::file_locks::list_for_team(&s.file_locks, team_id)
    }

    /// 動的ロールを team_id スコープで登録。既存があれば上書き。
    /// 既存 builtin (`role_profile_summary` に居る id) との衝突は呼び出し側でチェック済み前提。
    pub async fn register_dynamic_role(&self, role: DynamicRole) {
        let mut s = self.state.lock().await;
        s.dynamic_roles
            .entry(role.team_id.clone())
            .or_default()
            .insert(role.id.clone(), role);
    }

    /// team_id スコープの動的ロール一覧を返す
    pub async fn get_dynamic_roles(&self, team_id: &str) -> Vec<DynamicRole> {
        let s = self.state.lock().await;
        s.dynamic_roles
            .get(team_id)
            .map(|m| m.values().cloned().collect())
            .unwrap_or_default()
    }

    /// 任意 team_id スコープから動的ロール 1 件を引く
    pub async fn get_dynamic_role(&self, team_id: &str, role_id: &str) -> Option<DynamicRole> {
        let s = self.state.lock().await;
        s.dynamic_roles
            .get(team_id)
            .and_then(|m| m.get(role_id).cloned())
    }

    /// canvas 復元時に renderer 側 dynamic_roles をまとめて Hub に流し込むための入口。
    /// 既存をクリアしてから一括 insert する (team_id スコープ単位)。
    /// Issue #513: `dynamic_role::replay_persisted_dynamic_roles_for_team` 経由で実際に
    /// 呼ばれているため、Issue #739 で stale な `#[allow(dead_code)]` を除去した。
    pub async fn replace_dynamic_roles(&self, team_id: &str, roles: Vec<DynamicRole>) {
        let mut s = self.state.lock().await;
        let entry = s.dynamic_roles.entry(team_id.to_string()).or_default();
        entry.clear();
        for r in roles {
            entry.insert(r.id.clone(), r);
        }
    }

    // ===== Issue #518: engine policy helpers =====

    /// `team_id` の現在の engine policy を返す。team が未登録 / 未設定なら既定 `MixedAllowed`。
    pub async fn get_engine_policy(&self, team_id: &str) -> EnginePolicy {
        let s = self.state.lock().await;
        s.teams
            .get(team_id)
            .map(|t| t.engine_policy.clone())
            .unwrap_or_default()
    }

    /// `team_id` の engine policy を上書きする。team entry が無ければ作成する。
    /// 主に `team_create_leader` (チーム作成 / leader 引き継ぎ) で呼ばれる。
    pub async fn set_engine_policy(&self, team_id: &str, policy: EnginePolicy) {
        let mut s = self.state.lock().await;
        let team = s
            .teams
            .entry(team_id.to_string())
            .or_insert_with(TeamInfo::default);
        team.engine_policy = policy;
    }

    /// renderer から role profile summary を同期 (team_list_role_profiles の戻り値)
    pub async fn set_role_profile_summary(&self, summary: Vec<RoleProfileSummary>) {
        let mut s = self.state.lock().await;
        s.role_profile_summary = summary;
    }

    pub async fn get_role_profile_summary(&self) -> Vec<RoleProfileSummary> {
        self.state.lock().await.role_profile_summary.clone()
    }
}

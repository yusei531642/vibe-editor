//! `MemberDiagnostics` struct と `team_diagnostics` 用の診断 timestamp / counter 計算 impl。
//!
//! Issue #736: 旧 `state.rs` から member 診断に関する型・メソッドを切り出し。

use crate::team_hub::TeamHub;

use super::hub_state::extract_no_conversation_session_id;

/// Issue #342 Phase 3 (3.1): `team_diagnostics` で返す診断 timestamp / counter。
/// 全 timestamp は `chrono::Utc::now().to_rfc3339()` (ISO8601 / RFC3339)。
/// counter は `saturating_add(1)` でオーバーフロー時は `u64::MAX` 飽和。
#[derive(Clone, Debug, Default)]
pub struct MemberDiagnostics {
    /// `try_register_pending_recruit` が成功した瞬間の timestamp。
    /// 旧 entry (handshake 未完で再 recruit された agent_id) は新値で上書き。
    pub recruited_at: String,
    /// `resolve_pending_recruit` で handshake が完了した最後の timestamp。
    /// `online: true` だが `last_handshake_at: null` → handshake 未完を可視化。
    pub last_handshake_at: Option<String>,
    /// Agent 自身が操作したアクティビティ (handshake / send / read / status / update_task / dismiss) の最終時刻。
    /// 他者からの team_send 配信成功では更新しない。
    pub last_seen_at: Option<String>,
    /// この agent が他者から message を受領した最終時刻 (inject 成功 = 受領)。
    pub last_message_in_at: Option<String>,
    /// この agent が team_send で発信した最終時刻。
    pub last_message_out_at: Option<String>,
    pub messages_in_count: u64,
    pub messages_out_count: u64,
    pub tasks_claimed_count: u64,
    /// Issue #409: `team_status(status)` で agent が自己申告した最新ステータス文字列。
    /// Leader が `team_diagnostics` で「直近で生きているか / 何をしているか」を判断するために使う。
    pub current_status: Option<String>,
    /// Issue #409: `current_status` を更新した最終時刻 (RFC3339)。
    pub last_status_at: Option<String>,
    /// Issue #524: PTY から最後に出力 byte が流れた時刻 (RFC3339)。
    /// agent process が「ハングしているか / 単に待機中か」を Leader が判定する物理シグナルとして使う。
    /// `team_status` の自己申告と乖離した場合 (例: status は "running tests" だが PTY 出力が 5 分間無い)
    /// に diagnostics 側で `autoStale: true` を立てる元データ。
    /// 大量出力で hub の lock 競合を避けるため、PTY batcher が 1 秒間隔で dedup して update する。
    pub last_pty_output_at: Option<String>,
    /// 子プロセスが終了した最終時刻。`team_recruit` が handshake 直後の即終了を成功扱い
    /// しないための診断情報として保持する。
    pub last_exit_at: Option<String>,
    /// 子プロセスの終了コード。OS から取れない場合は -1。
    pub last_exit_code: Option<i64>,
    /// 終了直前の出力から推定した短い理由。
    pub last_exit_reason: Option<String>,
    /// Claude CLI が出した `No conversation found with session ID: ...` から抽出した session id。
    pub last_exit_session_id: Option<String>,
}

impl TeamHub {
    /// Issue #342 Phase 3 (3.3): `team_diagnostics` で見える member_diagnostics エントリを返す。
    /// agent_id が未登録なら None。
    pub async fn get_member_diagnostics(&self, agent_id: &str) -> Option<MemberDiagnostics> {
        self.state
            .lock()
            .await
            .member_diagnostics
            .get(agent_id)
            .cloned()
    }

    /// PTY の子プロセス終了を TeamHub 側の診断・整合性情報へ反映する。
    ///
    /// registry からは exit watcher が先に remove するため、roster 自体はそこで消える。
    /// ここでは role binding / file lock / 終了診断を掃除し、`team_recruit` が handshake
    /// 直後の即終了を検出して構造化エラーにできるようにする。
    pub async fn record_agent_process_exit(
        &self,
        team_id: &str,
        agent_id: &str,
        exit_code: i64,
        output_tail: Option<String>,
    ) {
        let now_iso = chrono::Utc::now().to_rfc3339();
        let session_id = output_tail
            .as_deref()
            .and_then(extract_no_conversation_session_id);
        let reason = if let Some(session_id) = &session_id {
            Some(format!(
                "No conversation found with session ID: {session_id}"
            ))
        } else {
            Some(format!("child process exited with exitCode={exit_code}"))
        };
        {
            let mut s = self.state.lock().await;
            let diag = s
                .member_diagnostics
                .entry(agent_id.to_string())
                .or_default();
            if diag.recruited_at.is_empty() {
                diag.recruited_at = now_iso.clone();
            }
            diag.last_exit_at = Some(now_iso);
            diag.last_exit_code = Some(exit_code);
            diag.last_exit_reason = reason;
            diag.last_exit_session_id = session_id;
            s.agent_role_bindings
                .remove(&(team_id.to_string(), agent_id.to_string()));
        }

        let released_lock_count = self
            .release_all_file_locks_for_agent(team_id, agent_id)
            .await;
        if released_lock_count > 0 {
            tracing::info!(
                "[teamhub] released {released_lock_count} advisory file lock(s) on process exit \
                 (team={} agent={})",
                team_id,
                agent_id
            );
        }
    }

}

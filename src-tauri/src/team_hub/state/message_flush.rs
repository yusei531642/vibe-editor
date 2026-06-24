//! Issue #1072 Part3: message log の write amplification を解消する dirty-flag + debounce flusher。
//!
//! # 背景
//! Phase1 (#1074) は `team_send` の push 毎 / `team_read` の read_by 更新毎に、直近 500 件を
//! 全件再シリアライズして atomic_write していた (message_log.rs の TODO(#1072))。アクティブな
//! マルチエージェント運用では send/read が秒間多数発生し、その都度フルファイル書き込みが走る
//! write amplification があった。
//!
//! # 方式 (dirty-flag + debounce)
//! send/read は即時 persist せず、対象 team を [`MessageFlusher::dirty`] にマークするだけにする。
//! Hub 起動時に spawn される [`TeamHub::run_message_flusher`] が、既定 [`DEBOUNCE_INTERVAL`]
//! (750ms) 間隔、または未 flush 変更が [`FLUSH_THRESHOLD`] (50) を超えたら即時 (Notify で起床) の
//! いずれかで dirty team をまとめて 1 回ずつ flush する (= 既存 `persist_team_messages` の atomic_write)。
//! これでバースト送受信が 1 write に coalesce され、ファイル形式・restore 経路 (Phase1) は不変。
//!
//! # 不変条件
//! - **flusher は state Mutex を await 跨ぎで保持しない** (deadlock 回避)。dirty 集合の drain は
//!   lock 下で完結させ、その後 lock を解放してから `persist_team_messages` (内部で再 lock) を呼ぶ。
//! - crash 窓 (最大 DEBOUNCE_INTERVAL) の loss は at-least-once (#1072 の online 再配信 +
//!   read_by の次回 send/read 再 snapshot) で許容する。
//! - `clear_team` / 明示 flush で確実に最終 write される。

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Notify;

use crate::team_hub::TeamHub;

/// debounce flush の基本間隔。
pub(crate) const DEBOUNCE_INTERVAL: Duration = Duration::from_millis(750);

/// 未 flush の変更件数がこれを超えたら interval を待たず即時 flush を起こす閾値。
pub(crate) const FLUSH_THRESHOLD: usize = 50;

/// message log の遅延書き込み状態 (HubState が 1 つ保持する)。
pub(crate) struct MessageFlusher {
    /// 次回 flush 対象の team_id 集合 (dedup)。
    pub(crate) dirty: HashSet<String>,
    /// 前回 flush 以降の変更件数 (件数ベースの即時 flush 判定用)。
    pub(crate) pending: usize,
    /// 閾値超過時に flusher を即時起床させる Notify。flusher 起動時に clone して使う。
    pub(crate) notify: Arc<Notify>,
}

impl Default for MessageFlusher {
    fn default() -> Self {
        Self {
            dirty: HashSet::new(),
            pending: 0,
            notify: Arc::new(Notify::new()),
        }
    }
}

impl TeamHub {
    /// Issue #1072: team の message log を「要 flush」とマークする (即時 write しない)。
    /// `team_send` / `team_read` の persist 経路はこれを呼ぶ。変更件数が [`FLUSH_THRESHOLD`] を
    /// 超えたら flusher を即時起床させる (lock は notify 前に解放する)。
    pub async fn mark_message_dirty(&self, team_id: &str) {
        let notify = {
            let mut s = self.state.lock().await;
            s.message_flusher.dirty.insert(team_id.to_string());
            s.message_flusher.pending = s.message_flusher.pending.saturating_add(1);
            if s.message_flusher.pending >= FLUSH_THRESHOLD {
                s.message_flusher.pending = 0;
                Some(s.message_flusher.notify.clone())
            } else {
                None
            }
        };
        if let Some(notify) = notify {
            notify.notify_one();
        }
    }

    /// dirty な team を 1 回ずつ flush する。**lock を await 跨ぎで保持しない**:
    /// dirty 集合の drain だけ lock 下で行い、解放後に `persist_team_messages` を呼ぶ。
    pub async fn flush_dirty_message_logs(&self) {
        let teams: Vec<String> = {
            let mut s = self.state.lock().await;
            s.message_flusher.pending = 0;
            s.message_flusher.dirty.drain().collect()
        };
        for team_id in teams {
            if let Err(e) = self.persist_team_messages(&team_id).await {
                tracing::warn!("[message_flush] persist team={team_id} failed: {e}");
            }
        }
    }

    /// 単一 team を即時 flush し dirty から外す (`clear_team` の最終 flush 用)。
    pub async fn flush_team_now(&self, team_id: &str) {
        {
            let mut s = self.state.lock().await;
            s.message_flusher.dirty.remove(team_id);
        }
        if let Err(e) = self.persist_team_messages(team_id).await {
            tracing::warn!("[message_flush] final flush team={team_id} failed: {e}");
        }
    }

    /// Issue #1072: debounce flusher 本体。Hub 起動 (`start`) で 1 度だけ spawn される。
    /// DEBOUNCE_INTERVAL 間隔、または閾値超過の Notify で起床して dirty team を flush する。
    pub async fn run_message_flusher(self, notify: Arc<Notify>) {
        loop {
            tokio::select! {
                _ = notify.notified() => {}
                _ = tokio::time::sleep(DEBOUNCE_INTERVAL) => {}
            }
            self.flush_dirty_message_logs().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::pty::SessionRegistry;
    use crate::team_hub::{TeamHub, TeamInfo};
    use std::sync::Arc;

    fn hub() -> TeamHub {
        TeamHub::new(Arc::new(SessionRegistry::new()))
    }

    /// project_root を持たない team を 1 件だけ登録する (persist_team_messages は no-op になるので
    /// flush がディスク (ユーザ home) を触らない = hermetic)。message_log の save/load 往復自体は
    /// message_log.rs の path-level テストで別途検証済み。
    async fn seed_dirtyable_team(hub: &TeamHub, team_id: &str) {
        let mut s = hub.state.lock().await;
        s.teams
            .entry(team_id.to_string())
            .or_insert_with(TeamInfo::default);
    }

    /// 複数回 mark_message_dirty しても dirty 集合は team 単位で 1 件に coalesce される
    /// (= flush は team あたり 1 write)。
    #[tokio::test]
    async fn repeated_marks_coalesce_to_single_dirty_entry() {
        let hub = hub();
        seed_dirtyable_team(&hub, "t1").await;
        for _ in 0..10 {
            hub.mark_message_dirty("t1").await;
        }
        let s = hub.state.lock().await;
        assert_eq!(s.message_flusher.dirty.len(), 1, "team は 1 件に集約される");
        assert!(s.message_flusher.dirty.contains("t1"));
        assert_eq!(s.message_flusher.pending, 10);
    }

    /// flush_dirty_message_logs は dirty を drain して空にし、pending を 0 に戻す
    /// (project_root 無し team なので実 write は no-op = hermetic)。
    #[tokio::test]
    async fn flush_drains_dirty_entries() {
        let hub = hub();
        seed_dirtyable_team(&hub, "t-flush").await;
        hub.mark_message_dirty("t-flush").await;
        assert_eq!(hub.state.lock().await.message_flusher.dirty.len(), 1);
        hub.flush_dirty_message_logs().await;
        let s = hub.state.lock().await;
        assert!(s.message_flusher.dirty.is_empty(), "flush 後 dirty は空");
        assert_eq!(s.message_flusher.pending, 0);
    }

    /// FLUSH_THRESHOLD 件で pending がリセットされる (即時 flush 起床のトリガ)。
    #[tokio::test]
    async fn pending_resets_when_threshold_crossed() {
        let hub = hub();
        seed_dirtyable_team(&hub, "t2").await;
        for _ in 0..super::FLUSH_THRESHOLD {
            hub.mark_message_dirty("t2").await;
        }
        // 閾値ちょうどで pending は 0 にリセットされ Notify 済み。
        assert_eq!(hub.state.lock().await.message_flusher.pending, 0);
    }
}

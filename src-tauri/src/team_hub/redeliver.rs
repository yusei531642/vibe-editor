//! Issue #1072 Part2: recipient が online 化 (handshake 成功 = Granted→Active) した時に、
//! 未読メッセージを一括再配信するフック。
//!
//! # 背景
//! Pty (push) mode では `team_send` 時に recipient が offline だと `deliver_message` の inject が
//! 失敗し (delivered_to に入らず未読のまま)、再接続時に再 push する経路が無かった。本フックは
//! handshake 直後に「自分宛て・未読・未配信」のメッセージを最新 [`REDELIVERY_MAX`] 件まで再 inject する。
//!
//! # 配信保証 (at-least-once + steady-state dedup)
//! 配信保証は **exactly-once ではなく at-least-once** である。共通の dedup 真実は
//! **delivered_to** (Pty で配信済みの集合) と **read_by** (既読) で、定常状態 (steady-state) では
//! これらが重複を抑止する:
//! - 候補は `!read_by.contains(me) && !delivered_to.contains(me)` のみ。配信成功で delivered_to を進める。
//! - 本フックは **Pty mode 限定で発火** する。Monitor/Both mode では Monitor watcher が hwm +
//!   `exclude_delivered` で catch-up するため、ここを発火させると watcher と二重配信になりうる。
//!   mode で責務を分けることで定常状態の二重配信を避ける。
//!
//! ただし `team_send` は message を **delivered_to=空で push し、inject 成功後に別 lock で
//! delivered_to を立てる**ため、その間 (TOCTOU 窓) に Both mode の watcher poll が
//! 「message 可視・delivered_to 未設定」を観測すると **稀に二重配信しうる**。これは意図的な選択で、
//! inject 前に delivered_to を立てると inject 失敗時に drop する (= より悪い) ため、
//! **duplicate > drop** を採る (agmsg #107 と整合)。
//!
//! # at-least-once UX
//! 再配信本文には `[再配信 msg #<id>]` を前置し、agent が重複を識別できるようにする
//! (inject.rs の banner 整形には手を入れず、deliver_message に渡す text の前置のみ)。

use chrono::Utc;

use crate::team_hub::delivery_mode::DeliveryMode;
use crate::team_hub::deliver::deliver_message;
use crate::team_hub::protocol::helpers::message_is_for_me;
use crate::team_hub::{CallContext, TeamHub, TeamInfo};

/// online 化時に再配信する最新メッセージ数の上限。これを超える古い未読は要約 1 行に畳む。
pub(crate) const REDELIVERY_MAX: usize = 20;

/// 再配信候補 1 件のスナップショット (state.lock を保持したまま inject しないための写し)。
struct Candidate {
    id: u32,
    from: String,
    message: String,
}

/// `team` から当該 agent の再配信候補を選ぶ純粋関数。
/// 「自分宛て・他人発・未読 (read_by に無い)・未配信 (delivered_to に無い)」を id 昇順で集め、
/// 最新 [`REDELIVERY_MAX`] 件に絞る。戻り値 `.0` は畳んだ古い未読件数 (要約用)。
fn select_candidates(team: &TeamInfo, role: &str, agent_id: &str) -> (usize, Vec<Candidate>) {
    let mut cand: Vec<Candidate> = team
        .messages
        .iter()
        .filter(|m| message_is_for_me(&m.resolved_recipient_ids, &m.to, role, agent_id))
        .filter(|m| m.from_agent_id != agent_id)
        .filter(|m| !m.read_by.iter().any(|a| a == agent_id))
        .filter(|m| !m.delivered_to.iter().any(|a| a == agent_id))
        .map(|m| Candidate {
            id: m.id,
            from: m.from.clone(),
            message: m.message.clone(),
        })
        .collect();
    cand.sort_by_key(|c| c.id);
    let older = cand.len().saturating_sub(REDELIVERY_MAX);
    let batch = if older > 0 { cand.split_off(older) } else { cand };
    (older, batch)
}

impl TeamHub {
    /// handshake 成功直後に呼ぶ。Pty mode 限定で未読を再配信する (best-effort)。
    /// `mod.rs` の handle_client から fire-and-forget で spawn される想定。
    pub async fn redeliver_unread_on_online(&self, ctx: &CallContext) {
        self.redeliver_unread_on_online_with_mode(ctx, DeliveryMode::from_env())
            .await;
    }

    /// mode を明示する内部実装 (テストで env を触らずに検証できるよう分離)。
    pub(crate) async fn redeliver_unread_on_online_with_mode(
        &self,
        ctx: &CallContext,
        mode: DeliveryMode,
    ) {
        // Part2 は Pty (純 push) mode 限定。Monitor/Both は watcher が catch-up するため発火させない。
        if !matches!(mode, DeliveryMode::Pty) {
            return;
        }

        // 候補を state.lock 下で snapshot し、lock を解放してから inject する (await 跨ぎで lock 非保持)。
        let (older_count, batch) = {
            let s = self.state.lock().await;
            let Some(team) = s.teams.get(&ctx.team_id) else {
                return;
            };
            select_candidates(team, &ctx.role, &ctx.agent_id)
        };

        if batch.is_empty() {
            return;
        }

        let registry = self.registry.clone();
        // 古い未読の要約 1 行 (情報のみ。特定 message に紐付かないので delivered_to は進めない)。
        if older_count > 0 {
            let text = format!(
                "[再配信] {older_count} 件のより古い未読メッセージがあります。team_read で取得してください。"
            );
            let _ = deliver_message(registry.clone(), &ctx.agent_id, "system", &text).await;
        }

        let mut delivered_ids: Vec<u32> = Vec::new();
        for c in &batch {
            // at-least-once 重複を識別できるよう message id を前置 (banner 整形には触れない)。
            let text = format!("[再配信 msg #{}] {}", c.id, c.message);
            match deliver_message(registry.clone(), &ctx.agent_id, &c.from, &text).await {
                Ok(()) => delivered_ids.push(c.id),
                Err(e) => tracing::warn!(
                    "[redeliver] inject failed agent={} id={} code={}",
                    ctx.agent_id,
                    c.id,
                    e.code()
                ),
            }
        }

        if delivered_ids.is_empty() {
            return;
        }

        // delivered_to / delivered_at を進める (read_by は触らない = #378)。共通 dedup 真実を更新し、
        // 次回 watcher / 再 handshake が同じものを再配信しないようにする。
        let now = Utc::now().to_rfc3339();
        {
            let mut s = self.state.lock().await;
            if let Some(team) = s.teams.get_mut(&ctx.team_id) {
                for m in team.messages.iter_mut() {
                    if delivered_ids.contains(&m.id) {
                        if !m.delivered_to.iter().any(|a| a == &ctx.agent_id) {
                            m.delivered_to.push(ctx.agent_id.clone());
                        }
                        m.delivered_at.insert(ctx.agent_id.clone(), now.clone());
                    }
                }
            }
        }
        // delivered_to を永続化対象に乗せる (debounce flusher 経由)。
        self.mark_message_dirty(&ctx.team_id).await;
        tracing::info!(
            "[redeliver] redelivered {} unread to agent={} (older_summarized={})",
            delivered_ids.len(),
            ctx.agent_id,
            older_count
        );
    }
}

#[cfg(test)]
mod tests {
    use super::{select_candidates, REDELIVERY_MAX};
    use crate::pty::SessionRegistry;
    use crate::team_hub::delivery_mode::DeliveryMode;
    use crate::team_hub::{CallContext, TeamHub, TeamInfo, TeamMessage};
    use std::collections::HashMap;
    use std::sync::Arc;

    fn hub() -> TeamHub {
        TeamHub::new(Arc::new(SessionRegistry::new()))
    }

    fn msg(id: u32, to_aid: &str, from_aid: &str, read_by: &[&str], delivered_to: &[&str]) -> TeamMessage {
        TeamMessage {
            id,
            from: "leader".into(),
            from_agent_id: from_aid.into(),
            to: "worker".into(),
            kind: "advisory".into(),
            resolved_recipient_ids: vec![to_aid.into()],
            message: format!("msg {id}"),
            timestamp: "2026-06-21T00:00:00Z".into(),
            read_by: read_by.iter().map(|s| s.to_string()).collect(),
            read_at: HashMap::new(),
            delivered_to: delivered_to.iter().map(|s| s.to_string()).collect(),
            delivered_at: HashMap::new(),
        }
    }

    fn team_with(msgs: Vec<TeamMessage>) -> TeamInfo {
        TeamInfo {
            project_root: Some("/tmp/repo-1072".into()),
            messages: msgs.into_iter().collect(),
            ..TeamInfo::default()
        }
    }

    /// 候補選定: 既読 / 配信済 / 自分発 / 他人宛て を全て除外し、未読・未配信・自分宛てのみ残す。
    #[test]
    fn select_excludes_read_delivered_self_and_others() {
        let team = team_with(vec![
            msg(1, "worker-1", "leader-1", &["worker-1"], &[]), // 既読 → 除外
            msg(2, "worker-1", "leader-1", &[], &["worker-1"]), // 配信済 → 除外
            msg(3, "worker-1", "worker-1", &[], &[]),           // 自分発 → 除外
            msg(4, "other-1", "leader-1", &[], &[]),            // 他人宛て → 除外
            msg(5, "worker-1", "leader-1", &[], &[]),           // 候補
        ]);
        let (older, batch) = select_candidates(&team, "worker", "worker-1");
        assert_eq!(older, 0);
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0].id, 5);
    }

    /// bounded: 未読が REDELIVERY_MAX を超えると最新 K 件だけ batch、残りは older_count に畳む。
    #[test]
    fn select_is_bounded_to_newest_k() {
        let total = (REDELIVERY_MAX + 5) as u32;
        let msgs: Vec<TeamMessage> = (1..=total)
            .map(|id| msg(id, "worker-1", "leader-1", &[], &[]))
            .collect();
        let team = team_with(msgs);
        let (older, batch) = select_candidates(&team, "worker", "worker-1");
        assert_eq!(older, 5, "古い 5 件は要約に畳む");
        assert_eq!(batch.len(), REDELIVERY_MAX);
        assert_eq!(batch.first().unwrap().id, 6, "最新 K 件 (id 6..=total) が batch");
        assert_eq!(batch.last().unwrap().id, total);
    }

    /// Both mode では Part2 を発火させない (= watcher と責務分離し定常状態の二重配信を避ける)。
    /// 発火しなければ delivered_to は一切変化しない。
    #[tokio::test]
    async fn both_mode_does_not_redeliver() {
        let hub = hub();
        let aid = "worker-1";
        {
            let mut s = hub.state.lock().await;
            s.teams
                .entry("t-both".into())
                .or_insert_with(|| team_with(vec![msg(1, aid, "leader-1", &[], &[])]));
        }
        let ctx = CallContext {
            team_id: "t-both".into(),
            role: "worker".into(),
            agent_id: aid.into(),
        };
        hub.redeliver_unread_on_online_with_mode(&ctx, DeliveryMode::Both)
            .await;
        let s = hub.state.lock().await;
        let team = s.teams.get("t-both").unwrap();
        assert!(
            team.messages[0].delivered_to.is_empty(),
            "Both mode では Part2 が発火せず delivered_to を進めない (watcher が担当)"
        );
    }

    /// Monitor mode も発火しない。
    #[tokio::test]
    async fn monitor_mode_does_not_redeliver() {
        let hub = hub();
        let aid = "worker-1";
        {
            let mut s = hub.state.lock().await;
            s.teams
                .entry("t-mon".into())
                .or_insert_with(|| team_with(vec![msg(1, aid, "leader-1", &[], &[])]));
        }
        let ctx = CallContext {
            team_id: "t-mon".into(),
            role: "worker".into(),
            agent_id: aid.into(),
        };
        hub.redeliver_unread_on_online_with_mode(&ctx, DeliveryMode::Monitor)
            .await;
        let s = hub.state.lock().await;
        assert!(s.teams.get("t-mon").unwrap().messages[0].delivered_to.is_empty());
    }

    /// REDELIVERY_MAX は名前付き定数で 20。
    #[test]
    fn redelivery_max_is_twenty() {
        assert_eq!(REDELIVERY_MAX, 20);
    }
}

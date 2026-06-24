//! tool: `team_read` — read past messages addressed to the caller.
//!
//! Issue #373 Phase 2 で `protocol.rs` から切り出し。

use crate::team_hub::{CallContext, TeamHub};
use chrono::Utc;
use serde_json::{json, Value};
use tauri::Emitter;

use super::super::helpers::message_is_for_me;
use super::error::ToolError;

pub async fn team_read(
    hub: &TeamHub,
    ctx: &CallContext,
    args: &Value,
) -> Result<Value, ToolError> {
    let unread_only = args
        .get("unread_only")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    // Issue #1072 Part1: Monitor watcher の per-agent watermark 用の additive パラメータ。
    // すべて省略時は従来挙動 (mark_read=true で read_by 前進 / since_id 無 / delivered 除外なし)。
    // - since_id: これ以下の id を除外 (hwm からの resume cursor、transport 層)。
    // - mark_read=false: read_by を進めない peek (watcher が emit 後に別途前進させるため)。
    // - exclude_delivered=true: delivered_to 済み (= Pty 配信済) を除外 (Both mode の定常状態での
    //   二重配信を抑制。送信中の TOCTOU 窓では稀に重複しうる = at-least-once)。
    let mark_read = args
        .get("mark_read")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let since_id = args.get("since_id").and_then(|v| v.as_u64()).map(|v| v as u32);
    let exclude_delivered = args
        .get("exclude_delivered")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let now_iso = Utc::now().to_rfc3339();
    // Issue #509: read_by に **新しく** 追加した message id を集める。
    // (元々 read_by に居る = 既読再 read のケースは inbox_read event で通知しない:
    //  既読フラグの状態は変わっておらず、UI 側 unread badge も再描画不要なため。)
    let mut newly_read_ids: Vec<u32> = Vec::new();
    let mut state = hub.state.lock().await;
    let team = state
        .teams
        .entry(ctx.team_id.clone())
        .or_insert_with(crate::team_hub::TeamInfo::default);
    let mut out = vec![];
    for m in team.messages.iter_mut() {
        let is_for_me =
            message_is_for_me(&m.resolved_recipient_ids, &m.to, &ctx.role, &ctx.agent_id);
        let from_someone_else = m.from_agent_id != ctx.agent_id;
        // 「自分宛て かつ 自分以外が送信したもの」だけ表示する (旧来の挙動を保ったまま肯定形で記述)
        if !(is_for_me && from_someone_else) {
            continue;
        }
        // Issue #1072: hwm resume — since_id 以下は配信済みとみなして除外 (transport cursor)。
        if let Some(sid) = since_id {
            if m.id <= sid {
                continue;
            }
        }
        // Issue #378: unread 判定は `read_by` のみを SSOT とする。`delivered_to` は
        // 「PTY に届いた」事実だけを示し、worker が認識/処理したことの証拠ではないため、
        // unread fallback の対象から外してはならない (= 1 回目の指示を確実に拾えるように)。
        if unread_only && m.read_by.contains(&ctx.agent_id) {
            continue;
        }
        // Issue #1072: Both mode の二重配信抑制 — Pty が既に配った (delivered_to 済) ものは
        // watcher の peek から除外する (exclude_delivered=true のときのみ。定常状態の dedup で、
        // 送信中の TOCTOU 窓では稀に重複しうる = at-least-once)。
        if exclude_delivered && m.delivered_to.contains(&ctx.agent_id) {
            continue;
        }
        let was_unread = !m.read_by.contains(&ctx.agent_id);
        // Issue #1072: mark_read=false (peek) のときは read_by を進めない (side-effect-free)。
        if mark_read && was_unread {
            m.read_by.push(ctx.agent_id.clone());
            newly_read_ids.push(m.id);
        }
        // Issue #342 Phase 3 (3.8): 自分が読んだ時刻を記録。
        // 旧実装では inject 成功で read_at に値が入ることがあり、それを尊重する optional 設計
        // だった。Issue #378 で inject 成功は delivered_at に分離したので、read_at は本当に
        // 「team_read 経由で読んだ瞬間」を指す。互換のため or_insert は残す
        // (sender 自身の send 時刻が初期値として入っているケースを潰さないため)。
        // Issue #1072: peek (mark_read=false) では read_at も更新しない。
        if mark_read {
            m.read_at
                .entry(ctx.agent_id.clone())
                .or_insert_with(|| now_iso.clone());
        }
        let received_at = m.read_at.get(&ctx.agent_id).cloned();
        // Issue #378: delivered_at を payload に含めることで、UI / 診断側が
        // 「配達済みだが未読」と「読了」を区別できるようにする。
        let delivered_at = m.delivered_at.get(&ctx.agent_id).cloned();
        out.push(json!({
            "id": m.id,
            "from": m.from,
            "kind": m.kind,
            "message": m.message,
            "timestamp": m.timestamp,
            "receivedAt": received_at,
            "deliveredAt": delivered_at,
        }));
    }
    let count = out.len();
    // Issue #342 Phase 3 (3.3): team_read を打った agent の last_seen_at を更新 (heartbeat 兼)
    let reader_diag = state.diagnostics_mut(&ctx.team_id, &ctx.agent_id);
    reader_diag.last_seen_at = Some(now_iso.clone());
    drop(state);
    // Issue #1071/#1072: read_by を更新したら message log を dirty マークし、debounce flusher が
    // まとめて persist する (Hub 再起動後も既読状態を復元可能)。再読 (read_by 不変 = newly_read_ids
    // が空) や peek (mark_read=false) のときはマークしない (無駄な write を起こさない)。
    if !newly_read_ids.is_empty() {
        hub.mark_message_dirty(&ctx.team_id).await;
    }
    // Issue #509: 「読了」を Canvas 側 UI に live で通知する。
    // 配送と読了を分離した指標を CardFrame の unread badge に反映する用途。
    // post-subscribe race は構造的に発生しない (read は send 後にしか来ない)。
    if !newly_read_ids.is_empty() {
        let app = hub.app_handle.lock().await.clone();
        if let Some(app) = app {
            let payload = crate::team_hub::events::InboxReadEventPayload {
                team_id: ctx.team_id.clone(),
                message_ids: newly_read_ids,
                read_by_agent_id: ctx.agent_id.clone(),
                read_by_role: ctx.role.clone(),
                read_at: now_iso.clone(),
            };
            if let Err(e) = app.emit("team:inbox_read", payload) {
                tracing::warn!("emit team:inbox_read failed: {e}");
            }
        }
    }
    Ok(json!({ "messages": out, "count": count }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty::SessionRegistry;
    use crate::team_hub::{TeamHub, TeamInfo, TeamMessage};
    use std::collections::HashMap;
    use std::sync::Arc;

    /// Issue #378: PTY inject (= delivered) は成功したが worker が認識していない 1 回目の
    /// メッセージを `team_read({unread_only: true})` で必ず取得できることを確認する。
    /// 旧実装は inject 成功で recipient を read_by に追加していたため、unread fallback で
    /// 0 件になり、worker が「再送」を要求するまで Leader 側からは異常を検知できなかった。
    #[tokio::test]
    async fn unread_only_returns_delivered_but_not_yet_read_message() {
        let hub = TeamHub::new(Arc::new(SessionRegistry::new()));
        let team_id = "team-test".to_string();
        let leader_aid = "leader-1".to_string();
        let worker_aid = "worker-1".to_string();

        {
            let mut state = hub.state.lock().await;
            let team = state
                .teams
                .entry(team_id.clone())
                .or_insert_with(TeamInfo::default);
            // Leader → Worker への 1 通: delivered_to に worker、read_by には sender 自身のみ
            let mut delivered_at = HashMap::new();
            delivered_at.insert(worker_aid.clone(), "2026-05-02T12:00:00Z".to_string());
            team.messages.push_back(TeamMessage {
                id: 1,
                from: "leader".into(),
                from_agent_id: leader_aid.clone(),
                to: "worker".into(),
                kind: "advisory".into(),
                resolved_recipient_ids: vec![worker_aid.clone()],
                message: "first instruction".into(),
                timestamp: "2026-05-02T12:00:00Z".into(),
                read_by: vec![leader_aid.clone()],
                read_at: HashMap::from([(leader_aid.clone(), "2026-05-02T12:00:00Z".into())]),
                delivered_to: vec![worker_aid.clone()],
                delivered_at: delivered_at.clone(),
            });
        }

        let ctx = CallContext {
            team_id: team_id.clone(),
            role: "worker".into(),
            agent_id: worker_aid.clone(),
        };
        let res = team_read(&hub, &ctx, &json!({ "unread_only": true }))
            .await
            .expect("team_read ok");
        let messages = res
            .get("messages")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        assert_eq!(
            messages.len(),
            1,
            "1 件目の指示が unread として取得できるべき"
        );
        let m = &messages[0];
        assert_eq!(m["id"].as_u64(), Some(1));
        assert_eq!(m["from"].as_str(), Some("leader"));
        assert_eq!(
            m["deliveredAt"].as_str(),
            Some("2026-05-02T12:00:00Z"),
            "deliveredAt が payload に含まれるべき"
        );

        // 2 回目を呼ぶと既読印が付いて 0 件になる
        let res2 = team_read(&hub, &ctx, &json!({ "unread_only": true }))
            .await
            .expect("team_read ok");
        assert_eq!(
            res2.get("count").and_then(|v| v.as_u64()),
            Some(0),
            "team_read 2 回目は unread が空であるべき"
        );

        // 既読印が message.read_by に worker_aid を追加していること
        let state = hub.state.lock().await;
        let team = state.teams.get(&team_id).unwrap();
        let m = team.messages.iter().find(|m| m.id == 1).unwrap();
        assert!(m.read_by.contains(&worker_aid));
        assert!(m.read_at.contains_key(&worker_aid));
    }

    // ===== Issue #1072 Part1: since_id / mark_read / exclude_delivered =====

    fn watcher_msg(id: u32, to_aid: &str, delivered_to: &[&str]) -> TeamMessage {
        TeamMessage {
            id,
            from: "leader".into(),
            from_agent_id: "leader-1".into(),
            to: "worker".into(),
            kind: "advisory".into(),
            resolved_recipient_ids: vec![to_aid.into()],
            message: format!("m{id}"),
            timestamp: "2026-06-21T00:00:00Z".into(),
            read_by: vec!["leader-1".into()],
            read_at: HashMap::new(),
            delivered_to: delivered_to.iter().map(|s| s.to_string()).collect(),
            delivered_at: HashMap::new(),
        }
    }

    async fn seed_msgs(hub: &TeamHub, team_id: &str, msgs: Vec<TeamMessage>) {
        let mut state = hub.state.lock().await;
        let team = state
            .teams
            .entry(team_id.to_string())
            .or_insert_with(TeamInfo::default);
        team.messages = msgs.into_iter().collect();
    }

    fn ids_of(res: &serde_json::Value) -> Vec<u64> {
        res.get("messages")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|m| m["id"].as_u64()).collect())
            .unwrap_or_default()
    }

    /// since_id はそれ以下の id を除外する (hwm resume cursor)。
    #[tokio::test]
    async fn since_id_filters_lower_or_equal_ids() {
        let hub = TeamHub::new(Arc::new(SessionRegistry::new()));
        let aid = "worker-1";
        seed_msgs(
            &hub,
            "t",
            vec![watcher_msg(1, aid, &[]), watcher_msg(2, aid, &[]), watcher_msg(3, aid, &[])],
        )
        .await;
        let ctx = CallContext { team_id: "t".into(), role: "worker".into(), agent_id: aid.into() };
        let res = team_read(&hub, &ctx, &json!({ "since_id": 1, "unread_only": false, "mark_read": false }))
            .await
            .unwrap();
        assert_eq!(ids_of(&res), vec![2, 3], "id<=since_id は除外");
    }

    /// mark_read=false は peek (read_by を進めない)。後続の unread_only でまだ未読として取れる。
    #[tokio::test]
    async fn mark_read_false_does_not_advance_read_by() {
        let hub = TeamHub::new(Arc::new(SessionRegistry::new()));
        let aid = "worker-1";
        seed_msgs(&hub, "t", vec![watcher_msg(1, aid, &[])]).await;
        let ctx = CallContext { team_id: "t".into(), role: "worker".into(), agent_id: aid.into() };

        let peek = team_read(&hub, &ctx, &json!({ "unread_only": false, "mark_read": false }))
            .await
            .unwrap();
        assert_eq!(ids_of(&peek), vec![1], "peek でも返る");
        {
            let s = hub.state.lock().await;
            let m = s.teams.get("t").unwrap().messages.iter().find(|m| m.id == 1).unwrap();
            assert!(!m.read_by.contains(&aid.to_string()), "peek は read_by を進めない");
        }
        // 通常 read (mark_read 既定 true) で初めて read_by が進む = 後方互換。
        let read = team_read(&hub, &ctx, &json!({ "unread_only": true })).await.unwrap();
        assert_eq!(ids_of(&read), vec![1]);
        let s = hub.state.lock().await;
        let m = s.teams.get("t").unwrap().messages.iter().find(|m| m.id == 1).unwrap();
        assert!(m.read_by.contains(&aid.to_string()));
    }

    /// exclude_delivered=true は delivered_to 済み (Pty 配信済) を除外する (Both mode 二重配信防止)。
    #[tokio::test]
    async fn exclude_delivered_skips_pty_delivered() {
        let hub = TeamHub::new(Arc::new(SessionRegistry::new()));
        let aid = "worker-1";
        seed_msgs(
            &hub,
            "t",
            vec![watcher_msg(1, aid, &[aid]), watcher_msg(2, aid, &[])],
        )
        .await;
        let ctx = CallContext { team_id: "t".into(), role: "worker".into(), agent_id: aid.into() };
        // 除外なし: 両方返る。
        let all = team_read(&hub, &ctx, &json!({ "unread_only": false, "mark_read": false }))
            .await
            .unwrap();
        assert_eq!(ids_of(&all), vec![1, 2]);
        // 除外あり: Pty 配信済 (id=1) は出ない。
        let filtered = team_read(
            &hub,
            &ctx,
            &json!({ "unread_only": false, "mark_read": false, "exclude_delivered": true }),
        )
        .await
        .unwrap();
        assert_eq!(ids_of(&filtered), vec![2], "delivered_to 済みは除外");
    }
}

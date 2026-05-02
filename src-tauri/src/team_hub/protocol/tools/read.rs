//! tool: `team_read` — read past messages addressed to the caller.
//!
//! Issue #373 Phase 2 で `protocol.rs` から切り出し。

use crate::team_hub::{CallContext, TeamHub};
use chrono::Utc;
use serde_json::{json, Value};

use super::super::helpers::message_is_for_me;

pub async fn team_read(
    hub: &TeamHub,
    ctx: &CallContext,
    args: &Value,
) -> Result<Value, String> {
    let unread_only = args
        .get("unread_only")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let now_iso = Utc::now().to_rfc3339();
    let mut state = hub.state.lock().await;
    let team = state
        .teams
        .entry(ctx.team_id.clone())
        .or_insert_with(crate::team_hub::TeamInfo::default);
    let mut out = vec![];
    for m in team.messages.iter_mut() {
        let is_for_me = message_is_for_me(
            &m.resolved_recipient_ids,
            &m.to,
            &ctx.role,
            &ctx.agent_id,
        );
        let from_someone_else = m.from_agent_id != ctx.agent_id;
        // 「自分宛て かつ 自分以外が送信したもの」だけ表示する (旧来の挙動を保ったまま肯定形で記述)
        if !(is_for_me && from_someone_else) {
            continue;
        }
        // Issue #378: unread 判定は `read_by` のみを SSOT とする。`delivered_to` は
        // 「PTY に届いた」事実だけを示し、worker が認識/処理したことの証拠ではないため、
        // unread fallback の対象から外してはならない (= 1 回目の指示を確実に拾えるように)。
        if unread_only && m.read_by.contains(&ctx.agent_id) {
            continue;
        }
        if !m.read_by.contains(&ctx.agent_id) {
            m.read_by.push(ctx.agent_id.clone());
        }
        // Issue #342 Phase 3 (3.8): 自分が読んだ時刻を記録。
        // 旧実装では inject 成功で read_at に値が入ることがあり、それを尊重する optional 設計
        // だった。Issue #378 で inject 成功は delivered_at に分離したので、read_at は本当に
        // 「team_read 経由で読んだ瞬間」を指す。互換のため or_insert は残す
        // (sender 自身の send 時刻が初期値として入っているケースを潰さないため)。
        m.read_at
            .entry(ctx.agent_id.clone())
            .or_insert_with(|| now_iso.clone());
        let received_at = m.read_at.get(&ctx.agent_id).cloned();
        // Issue #378: delivered_at を payload に含めることで、UI / 診断側が
        // 「配達済みだが未読」と「読了」を区別できるようにする。
        let delivered_at = m.delivered_at.get(&ctx.agent_id).cloned();
        out.push(json!({
            "id": m.id,
            "from": m.from,
            "message": m.message,
            "timestamp": m.timestamp,
            "receivedAt": received_at,
            "deliveredAt": delivered_at,
        }));
    }
    let count = out.len();
    // Issue #342 Phase 3 (3.3): team_read を打った agent の last_seen_at を更新 (heartbeat 兼)
    let reader_diag = state
        .member_diagnostics
        .entry(ctx.agent_id.clone())
        .or_default();
    reader_diag.last_seen_at = Some(now_iso);
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
            let team = state.teams.entry(team_id.clone()).or_insert_with(TeamInfo::default);
            // Leader → Worker への 1 通: delivered_to に worker、read_by には sender 自身のみ
            let mut delivered_at = HashMap::new();
            delivered_at.insert(worker_aid.clone(), "2026-05-02T12:00:00Z".to_string());
            team.messages.push_back(TeamMessage {
                id: 1,
                from: "leader".into(),
                from_agent_id: leader_aid.clone(),
                to: "worker".into(),
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
        assert_eq!(messages.len(), 1, "1 件目の指示が unread として取得できるべき");
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
}

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
        if unread_only && m.read_by.contains(&ctx.agent_id) {
            continue;
        }
        if !m.read_by.contains(&ctx.agent_id) {
            m.read_by.push(ctx.agent_id.clone());
        }
        // Issue #342 Phase 3 (3.8): 自分が読んだ時刻を記録 (既に inject 経由で値が入って
        // いれば後勝ちで上書きせず保持する。最初の "received" 時刻を尊重するため)。
        m.read_at
            .entry(ctx.agent_id.clone())
            .or_insert_with(|| now_iso.clone());
        let received_at = m.read_at.get(&ctx.agent_id).cloned();
        out.push(json!({
            "id": m.id,
            "from": m.from,
            "message": m.message,
            "timestamp": m.timestamp,
            "receivedAt": received_at,
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

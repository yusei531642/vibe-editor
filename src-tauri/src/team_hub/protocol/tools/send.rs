//! tool: `team_send` — send a message into another team member's terminal.
//!
//! Issue #373 Phase 2 で `protocol.rs` から切り出し。

use crate::team_hub::error::SendError;
use crate::team_hub::{inject, CallContext, TeamHub, TeamMessage};
use chrono::Utc;
use serde_json::{json, Value};
use std::collections::HashMap;
use tauri::Emitter;

use super::super::consts::{MAX_MESSAGES_PER_TEAM, MAX_MESSAGE_LEN, SOFT_PAYLOAD_LIMIT};
use super::super::helpers::resolve_targets;

pub async fn team_send(
    hub: &TeamHub,
    ctx: &CallContext,
    args: &Value,
) -> Result<Value, String> {
    // trim は resolve_targets 内で行うので、ここでは生文字列を保持して履歴 / 検証に使う。
    let to = args
        .get("to")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let message = args.get("message").and_then(|v| v.as_str()).unwrap_or("");
    if to.trim().is_empty() || message.is_empty() {
        return Err(SendError {
            code: "send_invalid_args".into(),
            message: "to and message are required".into(),
            phase: None,
            elapsed_ms: None,
        }
        .into_err_string());
    }
    // Issue #107: 1 メッセージのハードリミット超過は拒否 (途中で truncate すると意味が壊れる)
    if message.len() > MAX_MESSAGE_LEN {
        return Err(SendError {
            code: "send_message_too_large".into(),
            message: format!(
                "message too large: {} bytes (limit {} bytes)",
                message.len(),
                MAX_MESSAGE_LEN
            ),
            phase: None,
            elapsed_ms: None,
        }
        .into_err_string());
    }
    // 「長文ペイロード・ルール」: SOFT_PAYLOAD_LIMIT 超過は弾いてファイル経由を強制する。
    // PTY 注入のチャンク分割や受信側 Claude 入力制限で truncate しやすいので、
    // 「2000 文字超は .vibe-team/tmp/<short_id>.md に書き出してパスを送る」設計に倒す。
    if message.len() > SOFT_PAYLOAD_LIMIT {
        return Err(SendError {
            code: "send_payload_threshold".into(),
            message: format!(
                "message exceeds the long-payload threshold ({} > {} bytes). \
                 Write the full content to `.vibe-team/tmp/<short_id>.md` with the Write tool, \
                 then call team_send again with a brief summary plus the file path. \
                 (Inline messages up to 32 KiB are now delivered via bracketed paste, but anything \
                 beyond that should still be passed by file path.)",
                message.len(),
                SOFT_PAYLOAD_LIMIT
            ),
            phase: None,
            elapsed_ms: None,
        }
        .into_err_string());
    }

    // Issue #342 Phase 2: lock 順序を逆転。先に registry から宛先を解決して
    // `resolved_recipient_ids` を作り、それから state.lock を取って message を
    // 「最初から resolved_recipient_ids を埋めた状態」で push する。
    // 旧実装は (a) state.lock → push (b) drop → list_team_members → resolve_targets
    // の 2 段で、push 時点では recipient 情報を持てなかったため `team_read` が raw `to`
    // を読み手 ctx で再解釈する設計になっていた (identity 分離でサイレント沈黙の温床)。
    // 新順序では state.lock を保持しない時に registry を呼ぶので、deadlock 余地は無い。
    let registry = hub.registry.clone();
    let team_members = registry.list_team_members(&ctx.team_id);
    let active_leader_agent_id = {
        let state = hub.state.lock().await;
        state
            .teams
            .get(&ctx.team_id)
            .and_then(|team| team.active_leader_agent_id.clone())
    };
    let targets = resolve_targets(
        &team_members,
        &ctx.agent_id,
        &to,
        active_leader_agent_id.as_deref(),
    );
    let resolved_recipient_ids: Vec<String> =
        targets.iter().map(|(aid, _)| aid.clone()).collect();

    // メッセージ履歴に追加
    let timestamp = Utc::now().to_rfc3339();
    let mut state = hub.state.lock().await;
    let team = state
        .teams
        .entry(ctx.team_id.clone())
        .or_insert_with(crate::team_hub::TeamInfo::default);
    // Issue #115: messages.len()+1 だと履歴上限到達後に id が固定して衝突する。
    // 単調増加カウンタにすることで上限を超えても一意性を保つ。
    team.next_message_id = team.next_message_id.saturating_add(1);
    let msg_id = team.next_message_id;
    // Issue #342 Phase 3 (3.7 / 3.8): read_at の初期化。送信者自身は send 時刻で受領済み扱い。
    let mut initial_read_at: HashMap<String, String> = HashMap::new();
    initial_read_at.insert(ctx.agent_id.clone(), timestamp.clone());
    team.messages.push_back(TeamMessage {
        id: msg_id,
        from: ctx.role.clone(),
        from_agent_id: ctx.agent_id.clone(),
        to: to.clone(),
        resolved_recipient_ids: resolved_recipient_ids.clone(),
        message: message.to_string(),
        timestamp: timestamp.clone(),
        read_by: vec![ctx.agent_id.clone()],
        read_at: initial_read_at,
    });
    // Issue #107 / #216: 上限超過分は古い順に破棄してメモリ青天井を防ぐ。
    // VecDeque::pop_front() で O(1) eviction にする。
    while team.messages.len() > MAX_MESSAGES_PER_TEAM {
        let _ = team.messages.pop_front();
    }
    // Issue #342 Phase 3 (3.3): 送信者自身の last_message_out_at / messages_out_count / last_seen_at を更新
    let sender_diag = state
        .member_diagnostics
        .entry(ctx.agent_id.clone())
        .or_default();
    sender_diag.last_message_out_at = Some(timestamp.clone());
    sender_diag.last_seen_at = Some(timestamp.clone());
    sender_diag.messages_out_count = sender_diag.messages_out_count.saturating_add(1);
    drop(state);

    // Issue #150: 宛先メンバーへの inject を並列実行する。
    // 旧実装はメンバーごとに inject().await を直列で回し、to=all + 6 メンバー +
    // 4KB メッセージで 6 秒間 RPC を握りっぱなしになっていた (sleep 15ms × 64chunk × 6人)。
    // → 各宛先を tokio::spawn で並列発火して JoinSet で集約する。
    let preview: String = message.chars().take(80).collect();
    let app = hub.app_handle.lock().await.clone();

    let other_members: Vec<(String, String)> = team_members
        .iter()
        .filter(|(aid, _)| aid != &ctx.agent_id)
        .cloned()
        .collect();
    tracing::debug!(
        "[team_send] from agent={} role={} to={} → targets={}/{} other_members",
        ctx.agent_id,
        ctx.role,
        to,
        targets.len(),
        other_members.len()
    );
    if targets.is_empty() {
        tracing::warn!(
            "[team_send] no targets for to={:?} in team={} (other members: {:?})",
            to,
            ctx.team_id,
            other_members
        );
    }

    let mut join_set = tokio::task::JoinSet::new();
    for (target_aid, target_role) in &targets {
        let reg = registry.clone();
        let aid = target_aid.clone();
        let from_role = ctx.role.clone();
        let msg = message.to_string();
        let role_clone = target_role.clone();
        join_set.spawn(async move {
            let ok = inject::inject(reg, &aid, &from_role, &msg).await;
            (aid, role_clone, ok)
        });
    }

    // Issue #342 Phase 3 (3.7): 受領時刻を recipient agent_id ごとに追跡。
    // 全 target は最初 None で初期化し、inject 成功した瞬間に Some(now) を入れる。
    // 未配信 (inject 失敗) の target はそのまま None で戻り値に乗る。
    let mut received_at_per_recipient: HashMap<String, Option<String>> = targets
        .iter()
        .map(|(aid, _)| (aid.clone(), None))
        .collect();
    let mut delivered: Vec<String> = Vec::new();
    while let Some(joined) = join_set.join_next().await {
        if let Ok((target_aid, target_role, ok)) = joined {
            if !ok {
                continue;
            }
            delivered.push(if target_role.is_empty() {
                target_aid.clone()
            } else {
                target_role.clone()
            });
            let received_at = Utc::now().to_rfc3339();
            received_at_per_recipient.insert(target_aid.clone(), Some(received_at.clone()));
            // read_by / read_at に追加 + 受信側 diagnostics 更新
            {
                let mut state = hub.state.lock().await;
                if let Some(t) = state.teams.get_mut(&ctx.team_id) {
                    if let Some(m) = t.messages.iter_mut().find(|m| m.id == msg_id) {
                        m.read_by.push(target_aid.clone());
                        m.read_at.insert(target_aid.clone(), received_at.clone());
                    }
                }
                // Issue #342 Phase 3 (3.3): 受信側 diagnostics 更新
                let recipient_diag = state
                    .member_diagnostics
                    .entry(target_aid.clone())
                    .or_default();
                recipient_diag.last_message_in_at = Some(received_at.clone());
                recipient_diag.last_seen_at = Some(received_at.clone());
                recipient_diag.messages_in_count =
                    recipient_diag.messages_in_count.saturating_add(1);
            }
            // Phase 3: hand-off イベントを Canvas にブロードキャスト
            if let Some(app) = &app {
                let payload = json!({
                    "teamId": ctx.team_id,
                    "fromAgentId": ctx.agent_id,
                    "fromRole": ctx.role,
                    "toAgentId": target_aid,
                    "toRole": target_role,
                    "preview": preview,
                    "messageId": msg_id,
                    "timestamp": timestamp,
                });
                if let Err(e) = app.emit("team:handoff", payload) {
                    tracing::warn!("emit team:handoff failed: {e}");
                }
            }
        }
    }

    let note = if delivered.is_empty() {
        // 受信者ゼロは「サイレント失敗」を起こしがちなので、現在のメンバーを文字列でヒントする。
        // 同 role 複数名がいる場合に "[programmer, programmer]" のような重複表示を避けるため
        // sort + dedup で一意化する (順序を安定させたいので HashSet ではなく Vec で処理)。
        let mut hint: Vec<String> = other_members
            .iter()
            .map(|(_, r)| r.clone())
            .filter(|r| !r.is_empty())
            .collect();
        hint.sort();
        hint.dedup();
        if hint.is_empty() {
            format!(
                "宛先 '{to}' に該当するメンバーがチームに居ません (自分以外のメンバーが 0 名)。"
            )
        } else {
            format!(
                "宛先 '{to}' に該当するメンバーが居ません。現在のメンバーロール: {hint:?} (role 名 / agentId / 'all' で指定してください)"
            )
        }
    } else {
        format!("{} 名に直接配信しました。", delivered.len())
    };
    Ok(json!({
        "success": true,
        "messageId": msg_id,
        "delivered": delivered,
        "note": note,
        "sentAt": timestamp,
        "receivedAtPerRecipient": received_at_per_recipient,
    }))
}

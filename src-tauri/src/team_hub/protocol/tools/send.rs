//! tool: `team_send` — send a message into another team member's terminal.
//!
//! Issue #373 Phase 2 で `protocol.rs` から切り出し。

use crate::team_hub::{inject, CallContext, MemberDiagnostics, TeamHub, TeamMessage};

use super::error::SendError;
use chrono::Utc;
use serde_json::{json, Value};
use std::collections::HashMap;
use tauri::Emitter;

use super::super::consts::{MAX_MESSAGES_PER_TEAM, MAX_MESSAGE_LEN, SOFT_PAYLOAD_LIMIT};
use super::super::helpers::resolve_targets;

fn record_recipient_delivery_diagnostics(diagnostics: &mut MemberDiagnostics, delivered_at: &str) {
    diagnostics.last_message_in_at = Some(delivered_at.to_string());
    diagnostics.messages_in_count = diagnostics.messages_in_count.saturating_add(1);
}

fn optional_string(args: &Value, snake: &str, camel: &str) -> Option<String> {
    args.get(snake)
        .or_else(|| args.get(camel))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToOwned::to_owned)
}

fn is_leader_report(to: &str, message: &str, sender_role: &str) -> bool {
    if sender_role == "leader" || to.trim() != "leader" {
        return false;
    }
    let lower = message.to_ascii_lowercase();
    message.contains("完了報告")
        || lower.contains("completion report")
        || lower.contains("done:")
        || lower.contains("blocked")
        || message.contains("ブロック")
}

fn report_kind(message: &str) -> &'static str {
    let lower = message.to_ascii_lowercase();
    if lower.contains("blocked") || message.contains("ブロック") {
        "blocked"
    } else {
        "message"
    }
}

pub async fn team_send(hub: &TeamHub, ctx: &CallContext, args: &Value) -> Result<Value, String> {
    // trim は resolve_targets 内で行うので、ここでは生文字列を保持して履歴 / 検証に使う。
    let to = args
        .get("to")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let message = args.get("message").and_then(|v| v.as_str()).unwrap_or("");
    let handoff_id = optional_string(args, "handoff_id", "handoffId");
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
    // Issue #512: 「長文ペイロード」(SOFT_PAYLOAD_LIMIT 超過) は **Hub 側で自動 spool 化** する。
    //
    // 旧実装は呼び出し側 (Leader / HR / worker) に「自分でファイル書き出してから path で送れ」と
    // reject で要求していたため、運用知識への依存と再呼び出しの往復コストが発生していた
    // (Issue #107 の運用回避策が前提)。Hub が自動で `<project_root>/.vibe-team/tmp/<short_id>.md` に
    // 本文書き出し → message を「summary + attached: <path>」に置換することで、Leader が
    // 知らない状態でも長文が安全に流れる。
    //
    // 旧 `send_payload_threshold` error は project_root が無い (= MCP setup 未完の稀ケース) と
    // spool 書き込みが失敗した場合のみ発火する fallback として残す (code 名は旧名のまま、
    // message 文で「auto-spool 失敗」を伝える形にして既存 caller の condition 判定を壊さない)。
    let mut spooled_message: Option<String> = None;
    if message.len() > SOFT_PAYLOAD_LIMIT {
        let project_root = {
            let s = hub.state.lock().await;
            s.teams
                .get(&ctx.team_id)
                .and_then(|t| t.project_root.clone())
        };
        let project_root = match project_root.as_deref().map(str::trim).filter(|p| !p.is_empty())
        {
            Some(p) => p.to_string(),
            None => {
                return Err(SendError {
                    // Issue #512 ↔ #545 review: error code は旧名 `send_payload_threshold`
                    // を維持して後方互換を保つ。新実装で挙動が変わったのは「成功時に reject せず
                    // spool 化する」path であり、reject 時の error code は旧来の SOFT_PAYLOAD_LIMIT
                    // 超過と同じ意味で扱える。caller (Leader / HR / worker) が code 判定で
                    // fallback handler を持っていても、本 PR で挙動が壊れない。
                    code: "send_payload_threshold".into(),
                    message: format!(
                        "message exceeds the long-payload threshold ({} > {} bytes) and \
                         this team has no project_root configured for auto-spool. \
                         Setup the team via Canvas (setupTeamMcp) or write the full content to \
                         a file with the Write tool and call team_send again with a brief summary plus the file path.",
                        message.len(),
                        SOFT_PAYLOAD_LIMIT
                    ),
                    phase: None,
                    elapsed_ms: None,
                }
                .into_err_string());
            }
        };
        match crate::team_hub::spool::spool_long_payload(&project_root, message, "send").await {
            Ok(result) => {
                tracing::info!(
                    "[team_send] auto-spooled long payload ({} bytes) team={} role={} to={} → {}",
                    message.len(),
                    ctx.team_id,
                    ctx.role,
                    to,
                    result.spool_path.display()
                );
                spooled_message = Some(result.replacement_message);
            }
            Err(e) => {
                tracing::warn!(
                    "[team_send] auto-spool failed for team={}: {e:#}; falling back to reject",
                    ctx.team_id
                );
                return Err(SendError {
                    // Issue #512 ↔ #545 review: error code は旧名 `send_payload_threshold`
                    // を維持して後方互換を保つ。新実装で挙動が変わったのは「成功時に reject せず
                    // spool 化する」path であり、reject 時の error code は旧来の SOFT_PAYLOAD_LIMIT
                    // 超過と同じ意味で扱える。caller (Leader / HR / worker) が code 判定で
                    // fallback handler を持っていても、本 PR で挙動が壊れない。
                    code: "send_payload_threshold".into(),
                    message: format!(
                        "message exceeds the long-payload threshold ({} > {} bytes) and \
                         auto-spool to `.vibe-team/tmp/` failed: {e}. \
                         Write the full content to a file with the Write tool, then call team_send \
                         again with a brief summary plus the file path.",
                        message.len(),
                        SOFT_PAYLOAD_LIMIT
                    ),
                    phase: None,
                    elapsed_ms: None,
                }
                .into_err_string());
            }
        }
    }
    // 以後は spool 化された場合は `effective_message`、そうでなければ元 `message` を使う。
    // 既存の history 保存 (TeamMessage.message) / preview 切り出し / inject 全てに共通の
    // 「実際に送られた本文」として使われるので、shadow ではなく明示的な変数で扱う。
    let effective_message: &str = spooled_message.as_deref().unwrap_or(message);

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
    let resolved_recipient_ids: Vec<String> = targets.iter().map(|(aid, _)| aid.clone()).collect();

    // メッセージ履歴に追加
    let timestamp = Utc::now().to_rfc3339();
    let should_record_report = is_leader_report(&to, message, &ctx.role);
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
        message: effective_message.to_string(),
        timestamp: timestamp.clone(),
        // Issue #378: sender 自身は送信時点で既読扱いを継続。recipient は inject が成功
        // しても自動で read_by に入れない (= worker が `team_read` を実行する経路でしか
        // 既読印が付かない) ことで、未確認指示を unread fallback で再取得できるようにする。
        read_by: vec![ctx.agent_id.clone()],
        read_at: initial_read_at,
        delivered_to: Vec::new(),
        delivered_at: HashMap::new(),
    });
    // Issue #107 / #216: 上限超過分は古い順に破棄してメモリ青天井を防ぐ。
    // VecDeque::pop_front() で O(1) eviction にする。
    while team.messages.len() > MAX_MESSAGES_PER_TEAM {
        let _ = team.messages.pop_front();
    }
    if should_record_report {
        // Issue #512: worker_reports は **元 `message`** (spool 化 **前**) の先頭 500 文字を保持する。
        // worker_reports は Leader が後で「完了報告 / blocked の経緯」を読み返すための診断ログで、
        // 「summary + attached: <path>」だけが残ると情報量が著しく落ちる。spool ファイル本体は
        // `<project_root>/.vibe-team/tmp/` に残っているので、original の冒頭 500 文字 + ファイル
        // パス (= effective_message にも含まれる) の組み合わせで「report として何があったか」が
        // 後追いできる設計にする。
        let summary: String = message.chars().take(500).collect();
        team.worker_reports
            .push_back(crate::commands::team_state::WorkerReportSnapshot {
                id: format!("message-{msg_id}"),
                task_id: None,
                from_role: ctx.role.clone(),
                from_agent_id: ctx.agent_id.clone(),
                kind: report_kind(message).to_string(),
                summary,
                blocked_reason: None,
                next_action: None,
                artifact_path: None,
                payload: None,
                created_at: timestamp.clone(),
            });
        while team.worker_reports.len() > 50 {
            let _ = team.worker_reports.pop_front();
        }
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
    if should_record_report {
        if let Err(e) = hub.persist_team_state(&ctx.team_id).await {
            tracing::warn!("[team_send] persist worker report failed: {e}");
        }
    }

    // Issue #150: 宛先メンバーへの inject を並列実行する。
    // 旧実装はメンバーごとに inject().await を直列で回し、to=all + 6 メンバー +
    // 4KB メッセージで 6 秒間 RPC を握りっぱなしになっていた (sleep 15ms × 64chunk × 6人)。
    // → 各宛先を tokio::spawn で並列発火して JoinSet で集約する。
    let preview: String = effective_message.chars().take(80).collect();
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
        let msg = effective_message.to_string();
        let role_clone = target_role.clone();
        join_set.spawn(async move {
            let result = inject::inject(reg, &aid, &from_role, &msg).await;
            (aid, role_clone, result)
        });
    }

    // Issue #342 Phase 3 (3.7) / Issue #378:
    // - `delivered_at_per_recipient` は inject (= PTY 配達) が成功した瞬間の timestamp を持つ。
    //   旧 `receivedAtPerRecipient` は意味的に「PTY に届いた」≒「読まれた」を混同させていたため、
    //   Issue #378 では `deliveredAtPerRecipient` を新設して payload の正本にする。
    //   `receivedAtPerRecipient` は legacy alias として同じ値を残し、外部 UI / 解析ツールの後方互換を保つ。
    //
    // Issue #511: 旧実装は `inject()` の戻り値を `bool` に丸めていたため、partial failure
    // (session_replaced / final_cr_failed / write_partial 等) と「単に届かなかった」を区別できず、
    // Leader 視点で「届いたつもり」のまま再送ループに入る事故が起きていた。
    // 新実装は `Result<(), InjectError>` を受け取り、agent ごとの最終状態を 3 種類に分けて返す:
    //   - delivered: PTY に書ききって `\r` (送信確定) が成功した
    //   - failed: いずれかの phase で失敗した (reason.code に `inject_*` 名前空間)
    // 以下のフィールドを payload に追加する (既存 field はそのまま legacy として残す):
    //   - `deliveryStatus`: { agentId → { state: "delivered"|"failed", deliveredAt?, reason? } }
    //   - `failedRecipients`: 失敗した agent_id の配列 (UI が一覧表示しやすいよう正規化)
    // 失敗 agent ごとに `team:inject_failed` event を AppHandle へ emit し、Canvas 側 UI が
    // リアルタイムで warning indicator を出せるようにする。
    let mut delivered_at_per_recipient: HashMap<String, Option<String>> =
        targets.iter().map(|(aid, _)| (aid.clone(), None)).collect();
    let acknowledged_at_per_recipient: HashMap<String, Option<String>> =
        targets.iter().map(|(aid, _)| (aid.clone(), None)).collect();
    let mut delivery_status: serde_json::Map<String, Value> = serde_json::Map::new();
    let mut failed_recipients: Vec<Value> = Vec::new();
    // Issue #509: 「配送 (delivered) と読了 (read) の状態」を機械的に区別できるよう、
    // delivery_status に加えて pending / read_so_far の正規化リストを返す。
    //   - pending_recipients: PTY 配達は成功したが、send 時点でまだ `team_read` を呼んでいない
    //     recipient (= 大半の宛先がここに入る。delivered と同集合だが、用途が「経過時間で
    //     催促判断する」なので別配列として明示する)。
    //   - read_so_far_recipients: send 時点で既に read_by に含まれていた agent。送信者自身
    //     (sender 自身が send 時に self を read_by に push する設計のため、通常 1 件) と、
    //     稀に「同 agent_id が既に読了印を持っていた稀ケース」を保持する。
    // どちらも shape `{agentId, role, deliveredAt? | readAt?}` で UI が即時集計できる。
    let mut delivered: Vec<String> = Vec::new();
    let mut pending_recipients: Vec<Value> = Vec::new();
    while let Some(joined) = join_set.join_next().await {
        if let Ok((target_aid, target_role, result)) = joined {
            match result {
                Ok(()) => {
                    delivered.push(if target_role.is_empty() {
                        target_aid.clone()
                    } else {
                        target_role.clone()
                    });
                    let delivered_at = Utc::now().to_rfc3339();
                    delivered_at_per_recipient
                        .insert(target_aid.clone(), Some(delivered_at.clone()));
                    delivery_status.insert(
                        target_aid.clone(),
                        json!({
                            "state": "delivered",
                            "deliveredAt": delivered_at,
                        }),
                    );
                    // Issue #509: send 直後は read_by に sender 自身しか居ないので、
                    // delivered な recipient はすべて pending として加えてよい。
                    pending_recipients.push(json!({
                        "agentId": target_aid.clone(),
                        "role": target_role.clone(),
                        "deliveredAt": delivered_at.clone(),
                    }));
                    // Issue #378: read_by/read_at は触らない。delivered_to/delivered_at だけを更新する。
                    // (旧実装は inject 成功で recipient まで read_by に入れていたため、worker が実際に
                    //  Enter を確認していない 1 回目の指示も「既読」扱いになり、`team_read({unread_only: true})`
                    //  fallback で再取得できなかった。delivered/read を分離することで、worker が処理した
                    //  ことの真の証拠 (= team_read 呼び出し) でしか read_by に印が付かなくなる。)
                    {
                        let mut state = hub.state.lock().await;
                        if let Some(t) = state.teams.get_mut(&ctx.team_id) {
                            if let Some(m) = t.messages.iter_mut().find(|m| m.id == msg_id) {
                                if !m.delivered_to.iter().any(|id| id == &target_aid) {
                                    m.delivered_to.push(target_aid.clone());
                                }
                                m.delivered_at
                                    .insert(target_aid.clone(), delivered_at.clone());
                            }
                        }
                        // Issue #342 Phase 3 (3.3): 受信側 diagnostics 更新
                        let recipient_diag = state
                            .member_diagnostics
                            .entry(target_aid.clone())
                            .or_default();
                        record_recipient_delivery_diagnostics(recipient_diag, &delivered_at);
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
                Err(err) => {
                    // Issue #511: inject 失敗は一切無視せず、code (machine-readable) と
                    // message (human-readable) を両方残す。Leader / UI 側の分岐で使う。
                    let failed_at = Utc::now().to_rfc3339();
                    let reason_code = err.code();
                    let reason_message = err.to_string();
                    tracing::warn!(
                        "[team_send] inject failed for agent {} role={} code={} msg={}",
                        target_aid,
                        target_role,
                        reason_code,
                        reason_message
                    );
                    delivery_status.insert(
                        target_aid.clone(),
                        json!({
                            "state": "failed",
                            "failedAt": failed_at.clone(),
                            "reason": {
                                "code": reason_code,
                                "message": reason_message.clone(),
                            },
                        }),
                    );
                    failed_recipients.push(json!({
                        "agentId": target_aid.clone(),
                        "role": target_role.clone(),
                        "reason": {
                            "code": reason_code,
                            "message": reason_message.clone(),
                        },
                        "failedAt": failed_at.clone(),
                    }));
                    // Canvas 側 UI に live で警告アイコンを出すための event。
                    // post-subscribe race を許容する `subscribeEvent` 経路で受ける想定 (vibeeditor
                    // skill の guidelines 参照): inject_failed は send 後にしか来ないため、
                    // listener 登録前に emit が走る race は構造的に発生しない。
                    if let Some(app) = &app {
                        let payload = json!({
                            "teamId": ctx.team_id,
                            "fromAgentId": ctx.agent_id,
                            "fromRole": ctx.role,
                            "toAgentId": target_aid,
                            "toRole": target_role,
                            "messageId": msg_id,
                            "reasonCode": reason_code,
                            "reasonMessage": reason_message,
                            "failedAt": failed_at,
                        });
                        if let Err(e) = app.emit("team:inject_failed", payload) {
                            tracing::warn!("emit team:inject_failed failed: {e}");
                        }
                    }
                }
            }
        }
    }

    if let Some(handoff_id) = handoff_id {
        if let Some((target_aid, _)) = targets.iter().find(|(aid, _)| {
            delivered_at_per_recipient
                .get(aid)
                .and_then(|v| v.as_ref())
                .is_some()
        }) {
            if let Err(e) = hub
                .record_handoff_lifecycle(
                    &ctx.team_id,
                    &handoff_id,
                    "injected",
                    Some(target_aid.clone()),
                    Some("team_send delivered handoff".into()),
                )
                .await
            {
                tracing::warn!("[team_send] handoff lifecycle update failed: {e}");
            }
        }
    }

    let note = if delivered.is_empty() && failed_recipients.is_empty() {
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
    } else if failed_recipients.is_empty() {
        format!("{} 名に直接配信しました。", delivered.len())
    } else if delivered.is_empty() {
        // Issue #511: 全送信先が失敗。caller に「送ったけど誰にも届いていない」が伝わる文言にする。
        format!(
            "{} 名への配信が失敗しました (delivered=0)。failedRecipients[].reason.code を確認してください。",
            failed_recipients.len()
        )
    } else {
        // Issue #511: partial failure。delivered と failed の数を両方明示する。
        format!(
            "{} 名に配信、{} 名は失敗 (failedRecipients[].reason.code を確認してください)。",
            delivered.len(),
            failed_recipients.len()
        )
    };
    Ok(json!({
        "success": true,
        "messageId": msg_id,
        "delivered": delivered,
        "note": note,
        "sentAt": timestamp,
        // Issue #378: delivered と read を分離した正本フィールド。inject (= PTY 配達) 成功時刻だけを持つ。
        "deliveredAtPerRecipient": delivered_at_per_recipient,
        // legacy alias: 旧 UI / 診断ツールが `receivedAtPerRecipient` を読むため同値を残す。
        // 名前が「受信して読まれた時刻」を連想させやすいが、現行は `deliveredAtPerRecipient` と同義
        // (= inject 成功時刻)。読了印は `team_read` が呼ばれた瞬間に message.read_at に書かれる別経路。
        "receivedAtPerRecipient": delivered_at_per_recipient,
        "acknowledged": false,
        "acknowledgedAtPerRecipient": acknowledged_at_per_recipient,
        // Issue #511: agent_id ごとの最終 inject 結果。caller (Leader / UI) が delivered/failed
        // を 1 か所で機械的に分岐できる正本フィールド。`deliveredAtPerRecipient` は legacy として残す。
        // shape: { [agentId]: { state: "delivered", deliveredAt }
        //        | { state: "failed", failedAt, reason: { code, message } } }
        "deliveryStatus": Value::Object(delivery_status),
        // 失敗 agent_id の正規化済みリスト。UI が「再送候補」を一覧する用途。
        // 成功のみのときは空配列を返す (`null` ではない、JS 側で `.length === 0` で分岐できる)。
        "failedRecipients": Value::Array(failed_recipients),
        // Issue #509: 「配送 (delivered) と読了 (read) の状態」を区別できるよう、
        // pending (delivered だが send 時点で未読) と readSoFar (send 時点で既読) を正規化済みリストで返す。
        //   - pendingRecipients: 送信直後に Leader が「相手が読んだか」を 60s 後に確認するための候補リスト。
        //     `team_diagnostics.pendingInbox*` と組み合わせて督促判断する。
        //   - readSoFarRecipients: 送信時点で既読の agent (通常は sender 自身のみ)。caller 側 UI で
        //     send→read を相関させやすいよう含める (空でも配列は返す)。
        "pendingRecipients": Value::Array(pending_recipients),
        "readSoFarRecipients": json!([
            { "agentId": ctx.agent_id, "role": ctx.role, "readAt": timestamp }
        ]),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::team_hub::MemberDiagnostics;

    #[test]
    fn recipient_delivery_diagnostics_do_not_touch_last_seen_at() {
        let mut diagnostics = MemberDiagnostics {
            last_seen_at: Some("2026-05-04T09:55:00Z".into()),
            ..MemberDiagnostics::default()
        };

        record_recipient_delivery_diagnostics(&mut diagnostics, "2026-05-04T10:00:00Z");

        assert_eq!(
            diagnostics.last_seen_at.as_deref(),
            Some("2026-05-04T09:55:00Z")
        );
        assert_eq!(
            diagnostics.last_message_in_at.as_deref(),
            Some("2026-05-04T10:00:00Z")
        );
        assert_eq!(diagnostics.messages_in_count, 1);
    }
}

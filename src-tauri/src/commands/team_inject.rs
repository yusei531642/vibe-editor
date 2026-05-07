//! Issue #511: PTY inject の手動リトライ用 IPC。
//!
//! `team_send` が partial failure を返したとき (一部 agent への inject が失敗した場合)、
//! Canvas 側 UI のリトライボタンから呼ばれる。1 件単位で同じ message を再 inject する。
//!
//! 自動リトライ (`inject::inject` 内の `INJECT_MAX_RETRY=1`) は「1 byte も書いていない」
//! failure のみを対象とするため、`WritePartial` / `SessionReplaced` / `FinalCrFailed` は
//! 自動リトライを跨いだ後も failure のまま返ってくる。これらは「ユーザーが retry 同意を
//! 取って手動でリトライする」という UX 設計で扱う (= 二重 paste 事故をユーザー判断に委ねる)。
//!
//! セキュリティ:
//!  - renderer は信頼境界内 (Tauri + bundled JS) なので追加 auth は不要
//!  - 任意の agent_id への inject を許すと UI 経由で意図しない agent を踊らせられるため、
//!    「指定 messageId が指定 agentId を resolved_recipient_ids に含んでいる」ことを検証して、
//!    そうでない場合は `retry_invalid_recipient` で弾く

use crate::state::AppState;
use crate::team_hub::inject;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, State};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryInjectArgs {
    pub team_id: String,
    pub message_id: u32,
    pub agent_id: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RetryInjectResult {
    /// 再 inject が成功したか (= PTY に書き切って `\r` まで完了)。
    pub ok: bool,
    /// 失敗時の人間可読メッセージ。`InjectError::to_string()` をそのまま入れる。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// 失敗時の安定 code (`inject_*` 名前空間)。renderer の switch 文で分岐する用途。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
    /// `delivered` 時刻 (RFC3339)。`ok = false` のときは `None`。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivered_at: Option<String>,
    /// 失敗時の RFC3339 時刻。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_at: Option<String>,
}

/// `team_send` の partial failure に対する手動リトライ。同じ team / message / agent を 1 件単位で再 inject する。
#[tauri::command]
pub async fn team_send_retry_inject(
    app: AppHandle,
    state: State<'_, AppState>,
    args: RetryInjectArgs,
) -> Result<RetryInjectResult, String> {
    let hub = state.team_hub.clone();
    let registry = hub.registry.clone();

    // Step 1: message を lookup。lock は短く保持し、inject の long PTY write 中は離す。
    let lookup: Result<(String, String, String), String> = {
        let s = hub.state.lock().await;
        let team = match s.teams.get(&args.team_id) {
            Some(t) => t,
            None => {
                return Err(format!(
                    "{{\"code\":\"retry_unknown_team\",\"message\":\"unknown team_id '{}'\"}}",
                    args.team_id
                ))
            }
        };
        let msg = match team.messages.iter().find(|m| m.id == args.message_id) {
            Some(m) => m,
            None => {
                return Err(format!(
                    "{{\"code\":\"retry_unknown_message\",\"message\":\"message {} not found in team '{}' (history may have been evicted)\"}}",
                    args.message_id, args.team_id
                ))
            }
        };
        // セキュリティ: 指定 agent_id がその message の resolved_recipient_ids に含まれていなければ拒否。
        // UI から偽の agentId を指定して任意の inject を発火するのを防ぐ。
        if !msg
            .resolved_recipient_ids
            .iter()
            .any(|id| id == &args.agent_id)
        {
            return Err(format!(
                "{{\"code\":\"retry_invalid_recipient\",\"message\":\"agent '{}' was not a recipient of message {} (resolved_recipient_ids does not contain it)\"}}",
                args.agent_id, args.message_id
            ));
        }
        Ok((msg.message.clone(), msg.from.clone(), msg.from_agent_id.clone()))
    };
    let (text, from_role, from_agent_id) = lookup?;

    // Step 2: inject 再実行。state lock は drop 済み。
    let preview: String = text.chars().take(80).collect();
    match inject::inject(registry, &args.agent_id, &from_role, &text).await {
        Ok(()) => {
            let delivered_at = Utc::now().to_rfc3339();
            // message.delivered_to / delivered_at を更新 (再送成功時)。
            // 既に delivered_to に居る場合 (= 元から成功 + UI のリトライ重複押し) は no-op。
            {
                let mut s = hub.state.lock().await;
                if let Some(t) = s.teams.get_mut(&args.team_id) {
                    if let Some(m) = t.messages.iter_mut().find(|m| m.id == args.message_id) {
                        if !m.delivered_to.iter().any(|id| id == &args.agent_id) {
                            m.delivered_to.push(args.agent_id.clone());
                        }
                        m.delivered_at
                            .insert(args.agent_id.clone(), delivered_at.clone());
                    }
                }
            }
            // Canvas 側 UI が「retry で配達成功」を視覚化するため team:handoff を emit する。
            // from_role は元 sender の role を保つ (UI が「誰からの message か」を再描画できるように)。
            let payload = json!({
                "teamId": args.team_id,
                "fromAgentId": from_agent_id,
                "fromRole": from_role,
                "toAgentId": args.agent_id,
                "toRole": "",
                "preview": preview,
                "messageId": args.message_id,
                "timestamp": delivered_at,
                "retried": true,
            });
            if let Err(e) = app.emit("team:handoff", payload) {
                tracing::warn!("[retry_inject] emit team:handoff failed: {e}");
            }
            Ok(RetryInjectResult {
                ok: true,
                delivered_at: Some(delivered_at),
                ..Default::default()
            })
        }
        Err(err) => {
            let reason_code = err.code().to_string();
            let reason_message = err.to_string();
            let failed_at = Utc::now().to_rfc3339();
            tracing::warn!(
                "[retry_inject] re-inject failed for agent {} message {}: code={} msg={}",
                args.agent_id,
                args.message_id,
                reason_code,
                reason_message
            );
            // 再失敗時も `team:inject_failed` を emit して UI が state 更新できるようにする。
            let payload = json!({
                "teamId": args.team_id,
                "fromAgentId": from_agent_id,
                "fromRole": from_role,
                "toAgentId": args.agent_id,
                "toRole": "",
                "messageId": args.message_id,
                "reasonCode": reason_code,
                "reasonMessage": reason_message,
                "failedAt": failed_at,
                "retried": true,
            });
            if let Err(e) = app.emit("team:inject_failed", payload) {
                tracing::warn!("[retry_inject] emit team:inject_failed failed: {e}");
            }
            Ok(RetryInjectResult {
                ok: false,
                error: Some(err.to_string()),
                reason_code: Some(err.code().to_string()),
                failed_at: Some(failed_at),
                ..Default::default()
            })
        }
    }
}

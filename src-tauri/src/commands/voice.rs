// Issue #825: Voice Direction Mode (Beta) — OpenAI Realtime API で AI と会話して
// active Leader を指揮するための IPC handler 群。
//
// 設計の SSOT は spicy-popping-firefly plan を参照。要点:
// - API key は OS keyring (Windows Credential Manager / macOS Keychain / Linux
//   secret-service) に保管し、IPC で値を返さない (Renderer は has_api_key で
//   存在のみ確認できる)。
// - WebRTC は Renderer 側で直接張る。Rust は ephemeral key 発行 (= reqwest で
//   OpenAI に HTTPS POST) と Leader への inject を担当する 2 つの責務に専念し、
//   音声 stream そのものは Rust を通らない。
// - inject は既存 `team_hub::inject::inject` (bracketed-paste + sanitize +
//   retry guard) を再利用する。voice 用の追加 sanitize は不要。

use crate::commands::error::{CommandError, CommandResult};
use crate::pty::SessionRegistry;
use crate::state::AppState;
use crate::team_hub::inject as team_inject;
use chrono::Utc;
use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use tauri::State;

/// OS keyring 上で credential を識別する service 名。本クレート内に固定。
const KEYRING_SERVICE: &str = "vibe-editor";
/// keyring の account 名。将来 API key 種別を増やす場合はここを enum 化する。
const KEYRING_ACCOUNT: &str = "openai-realtime-api-key";

/// OpenAI Realtime ephemeral key 発行エンドポイント。
/// Issue #825 open question: GA で URL/Body 形が動きうるため、実装時に
/// developers.openai.com/docs/guides/realtime-webrtc を確認すること。
const OPENAI_REALTIME_CLIENT_SECRETS_URL: &str =
    "https://api.openai.com/v1/realtime/client_secrets";

const DEFAULT_MODEL: &str = "gpt-realtime-2";
const DEFAULT_LANGUAGE: &str = "ja";
const DEFAULT_VOICE: &str = "alloy";
const DEFAULT_TRANSCRIPTION_MODEL: &str = "gpt-4o-mini-transcribe";

// 32 KiB cap. `team_hub::inject` 側にも独自の `INJECT_MAX_PAYLOAD` があり、超過時は
// 末尾 truncate される。ここでも先に reject することで「サイレント truncate」を防ぐ。
const MAX_INJECT_TEXT_BYTES: usize = 32 * 1024;

// ---------- keyring 3 兄弟 ----------

#[tauri::command]
pub async fn voice_set_api_key(key: String) -> CommandResult<()> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err(CommandError::validation("API key is empty"));
    }
    // sk- prefix は OpenAI の規約上の慣例だが、project-scoped key 等で異なる可能性も
    // あるので strict reject はしない (Renderer 側で警告 dialog を出す)。Rust は値を
    // そのまま keyring に渡す。
    let owned = trimmed.to_string();
    tokio::task::spawn_blocking(move || -> Result<(), keyring::Error> {
        let entry = Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)?;
        entry.set_password(&owned)
    })
    .await
    .map_err(|e| CommandError::internal(format!("keyring task join failed: {e}")))?
    .map_err(map_keyring_error)?;
    tracing::info!("[voice] api_key stored in OS keyring");
    Ok(())
}

#[tauri::command]
pub async fn voice_clear_api_key() -> CommandResult<()> {
    tokio::task::spawn_blocking(|| -> Result<(), keyring::Error> {
        let entry = Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            // 元々存在しないなら成功扱い (UI は冪等)
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e),
        }
    })
    .await
    .map_err(|e| CommandError::internal(format!("keyring task join failed: {e}")))?
    .map_err(map_keyring_error)?;
    tracing::info!("[voice] api_key cleared from OS keyring");
    Ok(())
}

#[tauri::command]
pub async fn voice_has_api_key() -> CommandResult<bool> {
    let exists = tokio::task::spawn_blocking(|| -> Result<bool, keyring::Error> {
        let entry = Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)?;
        match entry.get_password() {
            Ok(_) => Ok(true),
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(e) => Err(e),
        }
    })
    .await
    .map_err(|e| CommandError::internal(format!("keyring task join failed: {e}")))?
    .map_err(map_keyring_error)?;
    Ok(exists)
}

/// keyring エラーを CommandError に正規化。値そのものは絶対にログに出さない。
fn map_keyring_error(e: keyring::Error) -> CommandError {
    match e {
        keyring::Error::NoEntry => CommandError::not_found("api key not stored"),
        keyring::Error::PlatformFailure(inner) => {
            // Linux で secret-service が利用不可な場合などが該当。
            tracing::warn!("[voice] OS keyring platform failure: {inner}");
            CommandError::internal(format!("OS keyring unavailable: {inner}"))
        }
        keyring::Error::NoStorageAccess(inner) => {
            tracing::warn!("[voice] OS keyring access denied: {inner}");
            CommandError::internal(format!("OS keyring access denied: {inner}"))
        }
        other => CommandError::internal(format!("OS keyring error: {other}")),
    }
}

// ---------- realtime session ----------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionArgs {
    pub model: Option<String>,
    pub language: Option<String>,
    pub voice: Option<String>,
    /// `confirmationMode === 'bypass'` のとき true。system prompt の「Always confirm」
    /// を緩めて即実行モードに切り替える。
    pub bypass_confirmation: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceRealtimeSession {
    pub ephemeral_key: String,
    /// epoch ms (Renderer 契約)。OpenAI が返す epoch seconds を `create_session`
    /// 内で ×1000 して詰める。JS の Date / Number と整合させるため。
    pub expires_at: i64,
    pub model: String,
    pub session_id: String,
    pub instructions: String,
}

#[tauri::command]
pub async fn voice_realtime_create_session(
    args: CreateSessionArgs,
) -> CommandResult<VoiceRealtimeSession> {
    let api_key = load_api_key_from_keyring()
        .await?
        .ok_or_else(|| CommandError::validation("voice.apiKey is not configured"))?;

    let model = args.model.as_deref().unwrap_or(DEFAULT_MODEL).to_string();
    let language = args
        .language
        .as_deref()
        .unwrap_or(DEFAULT_LANGUAGE)
        .to_string();
    let voice = args.voice.as_deref().unwrap_or(DEFAULT_VOICE).to_string();
    let bypass = args.bypass_confirmation.unwrap_or(false);

    let instructions = build_system_instructions(&language, bypass);
    let tools = build_function_tools();

    let request_body = json!({
        "session": {
            "type": "realtime",
            "model": &model,
            "voice": &voice,
            "instructions": &instructions,
            "modalities": ["audio", "text"],
            "input_audio_transcription": {
                "model": DEFAULT_TRANSCRIPTION_MODEL,
                "language": &language
            },
            "tools": tools
        }
    });

    let client = reqwest::Client::new();
    let res = client
        .post(OPENAI_REALTIME_CLIENT_SECRETS_URL)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await
        .map_err(|e| {
            // network 系エラー。API key 本体には触れずに人間可読メッセージを残す。
            CommandError::internal(format!("OpenAI request failed: {e}"))
        })?;

    let status = res.status();
    if !status.is_success() {
        let body_text = res
            .text()
            .await
            .unwrap_or_else(|e| format!("(failed to read body: {e})"));
        // body 中に api key が含まれていることは無い設計だが、念のため 400 文字に truncate
        // して長すぎる error ペイロードでログを汚さないようにする。
        let truncated: String = body_text.chars().take(400).collect();
        tracing::warn!(
            "[voice] OpenAI client_secrets failed status={} body={}",
            status,
            truncated
        );
        return Err(CommandError::internal(format!(
            "OpenAI {} error: {}",
            status, truncated
        )));
    }

    // レスポンス構造は OpenAI 側で微調整され得るので Value で受けて optional に取り出す。
    let parsed: serde_json::Value = res
        .json()
        .await
        .map_err(|e| CommandError::internal(format!("OpenAI response parse failed: {e}")))?;

    let ephemeral_key = parsed
        .get("client_secret")
        .and_then(|cs| cs.get("value"))
        .and_then(|v| v.as_str())
        .or_else(|| parsed.get("value").and_then(|v| v.as_str()))
        .ok_or_else(|| {
            CommandError::internal(
                "OpenAI response did not contain client_secret.value".to_string(),
            )
        })?
        .to_string();

    // OpenAI は epoch seconds で返すので Renderer 契約 (epoch ms) に揃えるため ×1000。
    // 0 / 取得失敗時はそのまま 0 を返す (UI 側は 0 を「不明」扱いにする想定)。
    let expires_at_sec = parsed
        .get("client_secret")
        .and_then(|cs| cs.get("expires_at"))
        .and_then(|v| v.as_i64())
        .or_else(|| parsed.get("expires_at").and_then(|v| v.as_i64()))
        .unwrap_or(0);
    let expires_at = expires_at_sec.saturating_mul(1000);

    let session_id = parsed
        .get("session")
        .and_then(|s| s.get("id"))
        .and_then(|v| v.as_str())
        .or_else(|| parsed.get("id").and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string();

    tracing::info!(
        "[voice] realtime session created model={} session_id={} expires_at={}",
        model,
        session_id,
        expires_at
    );

    Ok(VoiceRealtimeSession {
        ephemeral_key,
        expires_at,
        model,
        session_id,
        instructions,
    })
}

async fn load_api_key_from_keyring() -> CommandResult<Option<String>> {
    let result = tokio::task::spawn_blocking(|| -> Result<Option<String>, keyring::Error> {
        let entry = Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)?;
        match entry.get_password() {
            Ok(pw) => Ok(Some(pw)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e),
        }
    })
    .await
    .map_err(|e| CommandError::internal(format!("keyring task join failed: {e}")))?;
    result.map_err(map_keyring_error)
}

fn build_system_instructions(language: &str, bypass: bool) -> String {
    if bypass {
        format!(
            "You are a voice assistant inside vibe-editor. The user explicitly enabled \
\"bypass confirmation\" mode. The user will talk to you in {language} to give \
instructions to the active \"Leader\" agent.\n\
RULES:\n\
- As soon as the user gives a clear instruction, call `send_to_leader` with the \
  message text. Do NOT ask for verbal confirmation.\n\
- A short acknowledgment after sending is welcome (e.g., \"Sent.\") but keep it brief.\n\
- The user is in the middle of coding; do not slow them down with extra dialogue.",
            language = language
        )
    } else {
        format!(
            "You are a voice assistant inside vibe-editor, a Tauri-based IDE for directing \
AI coding agents. The user will talk to you in {language} to give instructions to the active \
\"Leader\" agent.\n\
RULES:\n\
- Always confirm the message text and the target verbally with the user before calling \
  the `send_to_leader` function.\n\
- If the user asks for any destructive action (`git push`, `rm`, `deploy`, etc.), repeat back \
  the EXACT command and ask for explicit confirmation.\n\
- Do not call `send_to_leader` unless the user clearly confirmed (e.g., \"yes\", \"送信して\", \"OK\").\n\
- Keep responses concise. The user is in the middle of coding.",
            language = language
        )
    }
}

fn build_function_tools() -> serde_json::Value {
    json!([
        {
            "type": "function",
            "name": "send_to_leader",
            "description": "Send a text message to the active Leader agent. Only call this AFTER explicit user confirmation (unless bypass_confirmation mode is active).",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "The message text to send to the Leader, in the user's intended language."
                    }
                },
                "required": ["text"]
            }
        }
    ])
}

// ---------- active target lookup ----------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetActiveTargetArgs {
    pub team_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTarget {
    pub team_id: String,
    pub agent_id: String,
    pub display_name: String,
    pub role: String,
}

#[tauri::command]
pub async fn voice_get_active_target(
    state: State<'_, AppState>,
    args: GetActiveTargetArgs,
) -> CommandResult<Option<VoiceTarget>> {
    let hub_state = state.team_hub.state.lock().await;

    // team_id 指定: そのチームの active_leader_agent_id を見る。
    // 未指定: active_leader_agent_id を持っている最初の team を採用。
    let mut found: Option<(String, String)> = None;
    if let Some(ref tid) = args.team_id {
        if let Some(team) = hub_state.teams.get(tid) {
            if let Some(ref leader_id) = team.active_leader_agent_id {
                found = Some((tid.clone(), leader_id.clone()));
            }
        }
    } else {
        for (tid, team) in hub_state.teams.iter() {
            if let Some(ref leader_id) = team.active_leader_agent_id {
                found = Some((tid.clone(), leader_id.clone()));
                break;
            }
        }
    }

    let Some((team_id, agent_id)) = found else {
        return Ok(None);
    };

    // role binding lookup (通常 "leader")。
    let role = hub_state
        .agent_role_bindings
        .get(&(team_id.clone(), agent_id.clone()))
        .cloned()
        .unwrap_or_else(|| "leader".to_string());

    // display name (UI 表示用)。先頭 8 文字だけ取り出して短い id を見せる。
    let short_id: String = agent_id.chars().take(8).collect();
    let display_name = format!("Leader ({} / {})", role, short_id);

    Ok(Some(VoiceTarget {
        team_id,
        agent_id,
        display_name,
        role,
    }))
}

// ---------- inject to leader ----------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendToLeaderArgs {
    pub team_id: String,
    pub agent_id: String,
    pub text: String,
    /// ユーザーの直近発話 (監査ログ用、inject 本文には含めない)。
    #[serde(default)]
    pub transcript: String,
    /// AI の直近応答 (監査ログ用)。
    #[serde(default)]
    pub ai_transcript: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSendResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivered_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[tauri::command]
pub async fn voice_send_to_leader(
    state: State<'_, AppState>,
    args: SendToLeaderArgs,
) -> CommandResult<VoiceSendResult> {
    // 引数バリデーション。
    if args.team_id.trim().is_empty() {
        return Err(CommandError::validation("teamId is empty"));
    }
    if args.agent_id.trim().is_empty() {
        return Err(CommandError::validation("agentId is empty"));
    }
    let text = args.text;
    if text.trim().is_empty() {
        return Err(CommandError::validation("text is empty"));
    }
    if text.len() > MAX_INJECT_TEXT_BYTES {
        return Err(CommandError::validation(format!(
            "text exceeds {} bytes (got {})",
            MAX_INJECT_TEXT_BYTES,
            text.len()
        )));
    }

    // leader race 再検証: UI 表示中の handoff で active leader が切り替わっていたら拒否する。
    {
        let hub_state = state.team_hub.state.lock().await;
        let Some(team) = hub_state.teams.get(&args.team_id) else {
            return Err(CommandError::not_found(format!(
                "team {} is not registered",
                args.team_id
            )));
        };
        match team.active_leader_agent_id.as_deref() {
            Some(current) if current == args.agent_id => { /* ok */ }
            Some(other) => {
                return Err(CommandError::validation(format!(
                    "agentId is no longer the active leader for team {} (current={})",
                    args.team_id, other
                )));
            }
            None => {
                return Err(CommandError::validation(format!(
                    "team {} has no active leader",
                    args.team_id
                )));
            }
        }
    } // lock release

    // 監査ログは body を出さず meta だけ残す。
    tracing::info!(
        team_id = %args.team_id,
        agent_id = %args.agent_id,
        text_chars = text.chars().count(),
        transcript_chars = args.transcript.chars().count(),
        ai_transcript_chars = args.ai_transcript.chars().count(),
        "[voice] inject"
    );

    let registry: Arc<SessionRegistry> = state.pty_registry.clone();
    let agent_id = args.agent_id.clone();
    let text_for_inject = text.clone();

    // CloseRequested handler の wait_idle と整合させるため inflight に計上する。
    let inject_future =
        async move { team_inject::inject(registry, &agent_id, "user-voice", &text_for_inject).await };
    let result = state.pty_inflight.track_async(inject_future).await;

    match result {
        Ok(()) => Ok(VoiceSendResult {
            ok: true,
            delivered_at: Some(Utc::now().to_rfc3339()),
            reason_code: None,
            error: None,
        }),
        Err(e) => {
            let code = e.code();
            let msg = e.to_string();
            tracing::warn!(
                team_id = %args.team_id,
                agent_id = %args.agent_id,
                code = %code,
                "[voice] inject failed: {msg}"
            );
            Ok(VoiceSendResult {
                ok: false,
                delivered_at: None,
                reason_code: Some(code.to_string()),
                error: Some(msg),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_instructions_always_mode_mentions_confirmation() {
        let s = build_system_instructions("ja", false);
        assert!(
            s.contains("confirm"),
            "always-mode instructions must instruct verbal confirmation: {s}"
        );
        assert!(s.contains("ja"), "language placeholder should be filled");
    }

    #[test]
    fn system_instructions_bypass_mode_skips_confirmation() {
        let s = build_system_instructions("en", true);
        assert!(s.contains("bypass"), "bypass-mode instructions must declare the mode");
        assert!(
            s.contains("Do NOT ask"),
            "bypass-mode instructions must tell the assistant not to ask for confirmation: {s}"
        );
    }

    #[test]
    fn function_tools_declare_send_to_leader_text_parameter() {
        let tools = build_function_tools();
        let first = &tools.as_array().expect("array")[0];
        assert_eq!(first["type"], "function");
        assert_eq!(first["name"], "send_to_leader");
        let required = first["parameters"]["required"]
            .as_array()
            .expect("required array");
        assert!(required.iter().any(|v| v == "text"));
    }
}

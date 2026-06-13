// api_agents.* command — Issue #994 API-driven Canvas Chat agents.

use crate::commands::atomic_write::atomic_write;
use crate::commands::error::{CommandError, CommandResult};
use chrono::Utc;
use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use uuid::Uuid;

const KEYRING_SERVICE: &str = "vibe-editor";
const SESSION_SCHEMA_VERSION: u32 = 1;
const MAX_AUTO_DEPTH: u32 = 3;
const MAX_AUTO_TURNS_PER_CHAIN: u32 = 6;
const MAX_SKILL_BYTES: usize = 48 * 1024;
const MAX_MESSAGE_BYTES: usize = 128 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiAgentConfig {
    pub id: String,
    pub name: String,
    pub runtime: String,
    pub provider_id: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_mode: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiAgentMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiAgentUsage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiAgentTurnLog {
    pub generation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chain_id: Option<String>,
    pub depth: u32,
    pub turn_number: u32,
    pub stop_reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<ApiAgentUsage>,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiAgentSession {
    pub schema_version: u32,
    pub session_id: String,
    pub agent_id: String,
    pub provider_id: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub messages: Vec<ApiAgentMessage>,
    pub turn_logs: Vec<ApiAgentTurnLog>,
    pub tool_mode: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiAgentSessionCreateRequest {
    #[serde(default)]
    pub session_id: Option<String>,
    pub agent_id: String,
    pub provider_id: String,
    pub model: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub tool_mode: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiAgentSkill {
    pub id: String,
    pub name: String,
    pub body: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiAgentSendRequest {
    pub session_id: String,
    pub card_instance_id: String,
    pub generation_id: String,
    pub agent: ApiAgentConfig,
    pub message: String,
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub skills: Option<Vec<ApiAgentSkill>>,
    #[serde(default)]
    pub chain_id: Option<String>,
    #[serde(default)]
    pub depth: Option<u32>,
    #[serde(default)]
    pub turn_budget: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiAgentSendResult {
    pub ok: bool,
    pub generation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub degraded_to_read_only: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiAgentStreamEvent {
    session_id: String,
    card_instance_id: String,
    generation_id: String,
    delta: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiAgentToolEvent {
    session_id: String,
    card_instance_id: String,
    generation_id: String,
    name: String,
    status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiAgentDoneEvent {
    session_id: String,
    card_instance_id: String,
    generation_id: String,
    message: ApiAgentMessage,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    usage: Option<ApiAgentUsage>,
    stop_reason: String,
    turn_count: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiAgentErrorEvent {
    session_id: String,
    card_instance_id: String,
    generation_id: String,
    message: String,
}

static SEND_LOCKS: once_cell::sync::Lazy<Mutex<HashMap<String, Arc<Mutex<()>>>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));
static HTTP_CLIENT: once_cell::sync::Lazy<reqwest::Client> =
    once_cell::sync::Lazy::new(reqwest::Client::new);

#[tauri::command]
pub async fn api_agent_provider_set_key(provider_id: String, key: String) -> CommandResult<()> {
    let provider_id = sanitize_provider_id(&provider_id)?;
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err(CommandError::validation("API key is empty"));
    }
    let account = keyring_account(&provider_id);
    let value = trimmed.to_string();
    tokio::task::spawn_blocking(move || -> Result<(), keyring::Error> {
        Entry::new(KEYRING_SERVICE, &account)?.set_password(&value)
    })
    .await
    .map_err(|e| CommandError::internal(format!("keyring task join failed: {e}")))?
    .map_err(map_keyring_error)?;
    Ok(())
}

#[tauri::command]
pub async fn api_agent_provider_clear_key(provider_id: String) -> CommandResult<()> {
    let provider_id = sanitize_provider_id(&provider_id)?;
    let account = keyring_account(&provider_id);
    tokio::task::spawn_blocking(move || -> Result<(), keyring::Error> {
        match Entry::new(KEYRING_SERVICE, &account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e),
        }
    })
    .await
    .map_err(|e| CommandError::internal(format!("keyring task join failed: {e}")))?
    .map_err(map_keyring_error)?;
    Ok(())
}

#[tauri::command]
pub async fn api_agent_provider_has_key(provider_id: String) -> CommandResult<bool> {
    let provider_id = sanitize_provider_id(&provider_id)?;
    let account = keyring_account(&provider_id);
    let exists = tokio::task::spawn_blocking(move || -> Result<bool, keyring::Error> {
        match Entry::new(KEYRING_SERVICE, &account)?.get_password() {
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

#[tauri::command]
pub async fn api_agent_session_create(
    req: ApiAgentSessionCreateRequest,
) -> CommandResult<ApiAgentSession> {
    validate_id("agentId", &req.agent_id)?;
    let session_id = match req.session_id {
        Some(id) if !id.trim().is_empty() => {
            validate_id("sessionId", &id)?;
            id
        }
        _ => Uuid::new_v4().to_string(),
    };
    let now = Utc::now().to_rfc3339();
    let session = ApiAgentSession {
        schema_version: SESSION_SCHEMA_VERSION,
        session_id,
        agent_id: req.agent_id,
        provider_id: req.provider_id,
        model: req.model,
        title: req.title,
        created_at: now.clone(),
        updated_at: now,
        messages: Vec::new(),
        turn_logs: Vec::new(),
        tool_mode: req.tool_mode.unwrap_or_else(|| "auto".to_string()),
    };
    save_session(&session).await?;
    Ok(session)
}

#[tauri::command]
pub async fn api_agent_session_load(session_id: String) -> CommandResult<Option<ApiAgentSession>> {
    validate_id("sessionId", &session_id)?;
    let path = session_path(&session_id)?;
    if !tokio::fs::try_exists(&path)
        .await
        .map_err(|e| CommandError::Io(e.to_string()))?
    {
        return Ok(None);
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| CommandError::Io(e.to_string()))?;
    serde_json::from_slice::<ApiAgentSession>(&bytes)
        .map(Some)
        .map_err(|e| CommandError::Parse(format!("failed to parse API agent session: {e}")))
}

#[tauri::command]
pub async fn api_agent_session_delete(session_id: String) -> CommandResult<()> {
    validate_id("sessionId", &session_id)?;
    let path = session_path(&session_id)?;
    match tokio::fs::remove_file(path).await {
        Ok(()) | Err(_) => Ok(()),
    }
}

#[tauri::command]
pub async fn api_agent_cancel(_session_id: String, _generation_id: String) -> CommandResult<()> {
    // v1 requests are short-lived reqwest calls. Cancellation is represented in the UI by
    // ignoring stale generationId events; this command is intentionally idempotent.
    Ok(())
}

#[tauri::command]
pub async fn api_agent_send(
    app: AppHandle,
    req: ApiAgentSendRequest,
) -> CommandResult<ApiAgentSendResult> {
    validate_id("sessionId", &req.session_id)?;
    validate_id("cardInstanceId", &req.card_instance_id)?;
    validate_id("generationId", &req.generation_id)?;
    if req.message.len() > MAX_MESSAGE_BYTES {
        return Err(CommandError::validation("message is too large"));
    }
    let depth = req.depth.unwrap_or(0);
    let budget = req.turn_budget.unwrap_or(MAX_AUTO_TURNS_PER_CHAIN);
    if depth > MAX_AUTO_DEPTH || budget == 0 {
        append_turn_log(
            &req.session_id,
            ApiAgentTurnLog {
                generation_id: req.generation_id.clone(),
                chain_id: req.chain_id.clone(),
                depth,
                turn_number: 0,
                stop_reason: "turn_budget_exceeded".to_string(),
                usage: None,
                created_at: Utc::now().to_rfc3339(),
            },
        )
        .await?;
        emit_tool(
            &app,
            &req,
            "auto-turn-budget",
            "skipped",
            Some("Auto turn depth/budget exceeded; waiting for user.".to_string()),
        );
        return Ok(ApiAgentSendResult {
            ok: true,
            generation_id: req.generation_id,
            degraded_to_read_only: None,
            error: None,
        });
    }

    let lock = {
        let mut locks = SEND_LOCKS.lock().await;
        locks
            .entry(req.session_id.clone())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    };
    let _guard = lock.lock().await;

    let mut session = load_or_create_session(&req).await?;
    session.messages.push(ApiAgentMessage {
        id: Uuid::new_v4().to_string(),
        role: "user".to_string(),
        content: req.message.clone(),
        created_at: Utc::now().to_rfc3339(),
        tool_name: None,
    });
    save_session(&session).await?;

    let provider = provider_preset(&req.agent.provider_id, req.agent.custom_base_url.as_deref())?;
    let degraded = req.agent.tool_mode.as_deref() == Some("readOnly") || !provider.supports_tools;
    if degraded {
        emit_tool(
            &app,
            &req,
            "team-tools",
            "skipped",
            Some(
                "Provider/model tool calling is unavailable; read-only chat mode is active."
                    .to_string(),
            ),
        );
    }

    let key = read_key(&req.agent.provider_id).await?;
    let skills_text = build_skills_context(req.skills.as_deref().unwrap_or(&[]));
    let system_prompt = [
        req.system_prompt.as_deref().unwrap_or("").trim(),
        req.agent.system_prompt.as_deref().unwrap_or("").trim(),
        skills_text.trim(),
    ]
    .into_iter()
    .filter(|s| !s.is_empty())
    .collect::<Vec<_>>()
    .join("\n\n");

    let response = call_provider(
        &provider,
        &key,
        &req.agent,
        &system_prompt,
        &session.messages,
    )
    .await;
    match response {
        Ok((content, usage, stop_reason)) => {
            emit_delta(&app, &req, &content);
            let message = ApiAgentMessage {
                id: Uuid::new_v4().to_string(),
                role: "assistant".to_string(),
                content,
                created_at: Utc::now().to_rfc3339(),
                tool_name: None,
            };
            session.messages.push(message.clone());
            let turn_count = session.turn_logs.len() as u32 + 1;
            session.turn_logs.push(ApiAgentTurnLog {
                generation_id: req.generation_id.clone(),
                chain_id: req.chain_id.clone(),
                depth,
                turn_number: turn_count,
                stop_reason: stop_reason.clone(),
                usage: usage.clone(),
                created_at: Utc::now().to_rfc3339(),
            });
            session.updated_at = Utc::now().to_rfc3339();
            save_session(&session).await?;
            let event_name = format!("api-agent:done:{}", req.session_id);
            let _ = app.emit(
                event_name.as_str(),
                ApiAgentDoneEvent {
                    session_id: req.session_id.clone(),
                    card_instance_id: req.card_instance_id.clone(),
                    generation_id: req.generation_id.clone(),
                    message,
                    usage,
                    stop_reason,
                    turn_count,
                },
            );
            Ok(ApiAgentSendResult {
                ok: true,
                generation_id: req.generation_id,
                degraded_to_read_only: Some(degraded),
                error: None,
            })
        }
        Err(err) => {
            let message = err.to_string();
            let event_name = format!("api-agent:error:{}", req.session_id);
            let _ = app.emit(
                event_name.as_str(),
                ApiAgentErrorEvent {
                    session_id: req.session_id.clone(),
                    card_instance_id: req.card_instance_id.clone(),
                    generation_id: req.generation_id.clone(),
                    message: message.clone(),
                },
            );
            Ok(ApiAgentSendResult {
                ok: false,
                generation_id: req.generation_id,
                degraded_to_read_only: Some(degraded),
                error: Some(message),
            })
        }
    }
}

#[derive(Clone)]
struct ProviderPreset {
    adapter: &'static str,
    base_url: String,
    supports_tools: bool,
}

fn provider_preset(
    provider_id: &str,
    custom_base_url: Option<&str>,
) -> CommandResult<ProviderPreset> {
    let preset = match provider_id {
        "openai" => ("openai-compatible", "https://api.openai.com/v1", true),
        "openrouter" => ("openai-compatible", "https://openrouter.ai/api/v1", true),
        "nvidia-nim" => (
            "openai-compatible",
            "https://integrate.api.nvidia.com/v1",
            false,
        ),
        "groq" => ("openai-compatible", "https://api.groq.com/openai/v1", false),
        "mistral" => ("openai-compatible", "https://api.mistral.ai/v1", true),
        "together" => ("openai-compatible", "https://api.together.xyz/v1", false),
        "cerebras" => ("openai-compatible", "https://api.cerebras.ai/v1", false),
        "anthropic" => ("anthropic", "https://api.anthropic.com/v1", true),
        "gemini" => (
            "gemini",
            "https://generativelanguage.googleapis.com/v1beta",
            true,
        ),
        "custom-openai-compatible" => (
            "openai-compatible",
            custom_base_url.unwrap_or("").trim(),
            false,
        ),
        _ => return Err(CommandError::validation("unknown providerId")),
    };
    if preset.1.is_empty() {
        return Err(CommandError::validation("custom base URL is required"));
    }
    Ok(ProviderPreset {
        adapter: preset.0,
        base_url: preset.1.trim_end_matches('/').to_string(),
        supports_tools: preset.2,
    })
}

async fn call_provider(
    provider: &ProviderPreset,
    key: &str,
    agent: &ApiAgentConfig,
    system_prompt: &str,
    messages: &[ApiAgentMessage],
) -> anyhow::Result<(String, Option<ApiAgentUsage>, String)> {
    match provider.adapter {
        "anthropic" => call_anthropic(provider, key, agent, system_prompt, messages).await,
        "gemini" => call_gemini(provider, key, agent, system_prompt, messages).await,
        _ => call_openai_compatible(provider, key, agent, system_prompt, messages).await,
    }
}

async fn call_openai_compatible(
    provider: &ProviderPreset,
    key: &str,
    agent: &ApiAgentConfig,
    system_prompt: &str,
    messages: &[ApiAgentMessage],
) -> anyhow::Result<(String, Option<ApiAgentUsage>, String)> {
    let mut req_messages = Vec::new();
    if !system_prompt.is_empty() {
        req_messages.push(json!({ "role": "system", "content": system_prompt }));
    }
    for m in messages {
        if m.role == "tool" {
            continue;
        }
        req_messages.push(json!({ "role": m.role, "content": m.content }));
    }
    let mut body = json!({
        "model": agent.model,
        "messages": req_messages,
        "stream": false
    });
    if let Some(t) = agent.temperature {
        body["temperature"] = json!(t);
    }
    if let Some(max) = agent.max_output_tokens {
        body["max_tokens"] = json!(max);
    }
    let value: Value = HTTP_CLIENT
        .post(format!("{}/chat/completions", provider.base_url))
        .bearer_auth(key)
        .json(&body)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let content = value["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string();
    let stop = value["choices"][0]["finish_reason"]
        .as_str()
        .unwrap_or("stop")
        .to_string();
    Ok((content, usage_from_value(&value["usage"]), stop))
}

async fn call_anthropic(
    provider: &ProviderPreset,
    key: &str,
    agent: &ApiAgentConfig,
    system_prompt: &str,
    messages: &[ApiAgentMessage],
) -> anyhow::Result<(String, Option<ApiAgentUsage>, String)> {
    let req_messages: Vec<Value> = messages
        .iter()
        .filter(|m| m.role == "user" || m.role == "assistant")
        .map(|m| json!({ "role": m.role, "content": m.content }))
        .collect();
    let mut body = json!({
        "model": agent.model,
        "messages": req_messages,
        "max_tokens": agent.max_output_tokens.unwrap_or(4096)
    });
    if !system_prompt.is_empty() {
        body["system"] = json!(system_prompt);
    }
    if let Some(t) = agent.temperature {
        body["temperature"] = json!(t);
    }
    let value: Value = HTTP_CLIENT
        .post(format!("{}/messages", provider.base_url))
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let content = value["content"]
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter_map(|p| p["text"].as_str())
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    let usage = Some(ApiAgentUsage {
        input_tokens: value["usage"]["input_tokens"].as_u64().map(|n| n as u32),
        output_tokens: value["usage"]["output_tokens"].as_u64().map(|n| n as u32),
        total_tokens: None,
    });
    let stop = value["stop_reason"].as_str().unwrap_or("stop").to_string();
    Ok((content, usage, stop))
}

async fn call_gemini(
    provider: &ProviderPreset,
    key: &str,
    agent: &ApiAgentConfig,
    system_prompt: &str,
    messages: &[ApiAgentMessage],
) -> anyhow::Result<(String, Option<ApiAgentUsage>, String)> {
    let mut contents = Vec::new();
    for m in messages {
        let role = if m.role == "assistant" {
            "model"
        } else {
            "user"
        };
        if m.role == "system" || m.role == "tool" {
            continue;
        }
        contents.push(json!({ "role": role, "parts": [{ "text": m.content }] }));
    }
    let mut body = json!({ "contents": contents });
    if !system_prompt.is_empty() {
        body["systemInstruction"] = json!({ "parts": [{ "text": system_prompt }] });
    }
    let value: Value = HTTP_CLIENT
        .post(format!(
            "{}/models/{}:generateContent",
            provider.base_url, agent.model
        ))
        .header("x-goog-api-key", key)
        .json(&body)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let content = value["candidates"][0]["content"]["parts"]
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter_map(|p| p["text"].as_str())
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    let usage = Some(ApiAgentUsage {
        input_tokens: value["usageMetadata"]["promptTokenCount"]
            .as_u64()
            .map(|n| n as u32),
        output_tokens: value["usageMetadata"]["candidatesTokenCount"]
            .as_u64()
            .map(|n| n as u32),
        total_tokens: value["usageMetadata"]["totalTokenCount"]
            .as_u64()
            .map(|n| n as u32),
    });
    let stop = value["candidates"][0]["finishReason"]
        .as_str()
        .unwrap_or("STOP")
        .to_string();
    Ok((content, usage, stop))
}

fn usage_from_value(value: &Value) -> Option<ApiAgentUsage> {
    if !value.is_object() {
        return None;
    }
    Some(ApiAgentUsage {
        input_tokens: value["prompt_tokens"].as_u64().map(|n| n as u32),
        output_tokens: value["completion_tokens"].as_u64().map(|n| n as u32),
        total_tokens: value["total_tokens"].as_u64().map(|n| n as u32),
    })
}

fn emit_delta(app: &AppHandle, req: &ApiAgentSendRequest, delta: &str) {
    let event_name = format!("api-agent:delta:{}", req.session_id);
    let _ = app.emit(
        event_name.as_str(),
        ApiAgentStreamEvent {
            session_id: req.session_id.clone(),
            card_instance_id: req.card_instance_id.clone(),
            generation_id: req.generation_id.clone(),
            delta: delta.to_string(),
        },
    );
}

fn emit_tool(
    app: &AppHandle,
    req: &ApiAgentSendRequest,
    name: &str,
    status: &str,
    detail: Option<String>,
) {
    let event_name = format!("api-agent:tool:{}", req.session_id);
    let _ = app.emit(
        event_name.as_str(),
        ApiAgentToolEvent {
            session_id: req.session_id.clone(),
            card_instance_id: req.card_instance_id.clone(),
            generation_id: req.generation_id.clone(),
            name: name.to_string(),
            status: status.to_string(),
            detail,
        },
    );
}

async fn load_or_create_session(req: &ApiAgentSendRequest) -> CommandResult<ApiAgentSession> {
    if let Some(s) = api_agent_session_load(req.session_id.clone()).await? {
        return Ok(s);
    }
    api_agent_session_create(ApiAgentSessionCreateRequest {
        session_id: Some(req.session_id.clone()),
        agent_id: req.agent.id.clone(),
        provider_id: req.agent.provider_id.clone(),
        model: req.agent.model.clone(),
        title: Some(req.agent.name.clone()),
        tool_mode: req.agent.tool_mode.clone(),
    })
    .await
}

async fn append_turn_log(session_id: &str, log: ApiAgentTurnLog) -> CommandResult<()> {
    let mut session = api_agent_session_load(session_id.to_string())
        .await?
        .ok_or_else(|| CommandError::not_found("API agent session not found"))?;
    session.turn_logs.push(log);
    session.updated_at = Utc::now().to_rfc3339();
    save_session(&session).await
}

async fn save_session(session: &ApiAgentSession) -> CommandResult<()> {
    let path = session_path(&session.session_id)?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| CommandError::Io(e.to_string()))?;
    }
    let json = serde_json::to_vec_pretty(session)?;
    atomic_write(&path, &json)
        .await
        .map_err(|e| CommandError::internal(e.to_string()))
}

fn session_path(session_id: &str) -> CommandResult<PathBuf> {
    validate_id("sessionId", session_id)?;
    Ok(crate::util::config_paths::api_agent_sessions_dir().join(format!("{session_id}.json")))
}

fn validate_id(label: &str, value: &str) -> CommandResult<()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ':')
    {
        return Err(CommandError::validation(format!("{label} is invalid")));
    }
    Ok(())
}

fn sanitize_provider_id(provider_id: &str) -> CommandResult<String> {
    validate_id("providerId", provider_id)?;
    Ok(provider_id.trim().to_ascii_lowercase())
}

fn keyring_account(provider_id: &str) -> String {
    format!("api-agent-provider-{provider_id}")
}

async fn read_key(provider_id: &str) -> CommandResult<String> {
    let provider_id = sanitize_provider_id(provider_id)?;
    let account = keyring_account(&provider_id);
    tokio::task::spawn_blocking(move || -> Result<String, keyring::Error> {
        Entry::new(KEYRING_SERVICE, &account)?.get_password()
    })
    .await
    .map_err(|e| CommandError::internal(format!("keyring task join failed: {e}")))?
    .map_err(map_keyring_error)
}

fn map_keyring_error(e: keyring::Error) -> CommandError {
    match e {
        keyring::Error::NoEntry => CommandError::not_found("api key not stored"),
        keyring::Error::PlatformFailure(inner) => {
            CommandError::internal(format!("OS keyring unavailable: {inner}"))
        }
        keyring::Error::NoStorageAccess(inner) => {
            CommandError::internal(format!("OS keyring access denied: {inner}"))
        }
        other => CommandError::internal(format!("OS keyring error: {other}")),
    }
}

fn build_skills_context(skills: &[ApiAgentSkill]) -> String {
    let mut out = String::new();
    let mut remaining = MAX_SKILL_BYTES;
    for skill in skills {
        if remaining == 0 {
            break;
        }
        let header = format!("\n\n## Skill: {} ({})\n", skill.name, skill.id);
        let body = if skill.body.len() > remaining {
            &skill.body[..skill
                .body
                .char_indices()
                .take_while(|(i, _)| *i <= remaining)
                .last()
                .map(|(i, c)| i + c.len_utf8())
                .unwrap_or(0)]
        } else {
            skill.body.as_str()
        };
        out.push_str(&header);
        out.push_str(body);
        remaining = remaining.saturating_sub(body.len());
    }
    out
}

#[allow(dead_code)]
fn _assert_path_is_absolute(path: &Path) -> bool {
    path.is_absolute()
}

// api_agents.* command — Issue #994 API-driven Canvas Chat agents.

use crate::commands::atomic_write::atomic_write;
use crate::commands::error::{CommandError, CommandResult};
use chrono::Utc;
use keyring::Entry;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use uuid::Uuid;

mod providers;
pub mod skills;
mod tools;
pub mod types;

#[cfg(test)]
mod tests;

use self::providers::{call_provider, provider_preset, TeamToolCtx, ToolRuntime};
use self::types::*;
use crate::state::{current_project_root, AppState};
use tauri::State;

const KEYRING_SERVICE: &str = "vibe-editor";

static SEND_LOCKS: once_cell::sync::Lazy<Mutex<HashMap<String, Arc<Mutex<()>>>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));

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
    state: State<'_, AppState>,
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
    // Issue #998: 選択 skill + 自動 vibe-team の SKILL.md 本文をサーバ側で読み込む。
    let project_root = current_project_root(&state.project_root).unwrap_or_default();
    let loaded_skills =
        skills::load_skill_bodies(&project_root, req.agent.skill_ids.as_deref().unwrap_or(&[])).await;
    let skills_text = build_skills_context(&loaded_skills);
    let system_prompt = [
        req.system_prompt.as_deref().unwrap_or("").trim(),
        req.agent.system_prompt.as_deref().unwrap_or("").trim(),
        skills_text.trim(),
    ]
    .into_iter()
    .filter(|s| !s.is_empty())
    .collect::<Vec<_>>()
    .join("\n\n");

    // tools_enabled (= !degraded) のとき read_file / list_dir を実行する tool-loop を回す。
    // read-only / 非対応 provider は tools=None で SSE chat に degrade。
    // closure 群は req/app を借用するため、後段で req のフィールドを move する前に
    // ブロックスコープで drop させる。
    let response = {
        let mut on_tool = |name: &str, status: &str, detail: Option<&str>| {
            emit_tool(&app, &req, name, status, detail.map(str::to_string));
        };
        let tools = if degraded {
            None
        } else {
            // team_id / role が揃っているときだけ team tool を有効化する (Issue #1004)。
            let team = req
                .team
                .as_ref()
                .filter(|t| !t.team_id.trim().is_empty() && !t.role.trim().is_empty())
                .map(|t| TeamToolCtx {
                    hub: state.team_hub.clone(),
                    team_id: t.team_id.clone(),
                    agent_id: t.agent_id.clone(),
                    role: t.role.clone(),
                });
            Some(ToolRuntime {
                project_root: &project_root,
                max_turns: budget,
                on_tool: &mut on_tool,
                team,
            })
        };
        let mut on_delta = |delta: &str| emit_delta(&app, &req, delta);
        call_provider(
            &provider,
            &key,
            &req.agent,
            &system_prompt,
            &session.messages,
            tools,
            &mut on_delta,
        )
        .await
    };
    match response {
        Ok((content, usage, stop_reason)) => {
            // 本文は既にストリーミングで emit 済み。done イベントで全文を確定させる。
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

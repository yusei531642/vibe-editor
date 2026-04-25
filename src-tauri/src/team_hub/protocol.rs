// MCP JSON-RPC プロトコルハンドラ
//
// 旧 team-hub.ts の handleMcpRequest 等価。
// initialize / tools/list / tools/call (team_send 等 7 ツール + 新 recruit 系) を実装。

use crate::team_hub::{inject, CallContext, TeamHub, TeamMessage, TeamTask};
use chrono::Utc;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::Emitter;
use uuid::Uuid;

const RECRUIT_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_MEMBERS_PER_TEAM: usize = 12;

pub async fn handle(hub: &TeamHub, ctx: &CallContext, req: &Value) -> Option<Value> {
    let method = req.get("method").and_then(|v| v.as_str()).unwrap_or("");
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let params = req
        .get("params")
        .cloned()
        .unwrap_or_else(|| json!({}));

    match method {
        "initialize" => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "protocolVersion": "2025-03-26",
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "vibe-team", "version": "2.0.0-rust" }
            }
        })),
        "notifications/initialized" | "notifications/cancelled" => None,
        "ping" => Some(json!({ "jsonrpc": "2.0", "id": id, "result": {} })),
        "tools/list" => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": { "tools": if ctx.team_id.is_empty() { json!([]) } else { tool_defs() } }
        })),
        "tools/call" => {
            let tool_name = params
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            let result = dispatch_tool(hub, ctx, tool_name, &args).await;
            match result {
                Ok(value) => Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "content": [
                            { "type": "text", "text": serde_json::to_string_pretty(&value).unwrap_or_default() }
                        ]
                    }
                })),
                Err(msg) => Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "content": [
                            { "type": "text", "text": json!({ "error": msg }).to_string() }
                        ],
                        "isError": true
                    }
                })),
            }
        }
        _ => {
            if !id.is_null() {
                Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32601, "message": format!("Method not found: {method}") }
                }))
            } else {
                None
            }
        }
    }
}

fn tool_defs() -> Value {
    json!([
        {
            "name": "team_send",
            "description": "Send a message directly into another team member's terminal.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "to": { "type": "string" },
                    "message": { "type": "string" }
                },
                "required": ["to", "message"]
            }
        },
        {
            "name": "team_read",
            "description": "Read past messages addressed to you.",
            "inputSchema": {
                "type": "object",
                "properties": { "unread_only": { "type": "boolean", "default": true } }
            }
        },
        {
            "name": "team_info",
            "description": "Get the current team roster and your identity.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "team_status",
            "description": "Report your current status (informational).",
            "inputSchema": {
                "type": "object",
                "properties": { "status": { "type": "string" } },
                "required": ["status"]
            }
        },
        {
            "name": "team_assign_task",
            "description": "Assign a task to a role.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "assignee": { "type": "string" },
                    "description": { "type": "string" }
                },
                "required": ["assignee", "description"]
            }
        },
        {
            "name": "team_get_tasks",
            "description": "List all tasks in the team.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "team_update_task",
            "description": "Update the status of a task.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task_id": { "type": "number" },
                    "status": { "type": "string" }
                },
                "required": ["task_id", "status"]
            }
        },
        {
            "name": "team_recruit",
            "description": "Spawn a new team member with the given role profile. Returns when the new agent has joined (up to 30s).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "role_profile_id": { "type": "string" },
                    "engine": { "type": "string", "enum": ["claude", "codex"] },
                    "agent_label_hint": { "type": "string" },
                    "custom_instructions": { "type": "string" }
                },
                "required": ["role_profile_id"]
            }
        },
        {
            "name": "team_dismiss",
            "description": "Remove a team member from the canvas. Closes their card and terminates their session.",
            "inputSchema": {
                "type": "object",
                "properties": { "agent_id": { "type": "string" } },
                "required": ["agent_id"]
            }
        },
        {
            "name": "team_list_role_profiles",
            "description": "List all available role profiles (id, label, permissions). Useful before calling team_recruit.",
            "inputSchema": { "type": "object", "properties": {} }
        }
    ])
}

async fn dispatch_tool(
    hub: &TeamHub,
    ctx: &CallContext,
    name: &str,
    args: &Value,
) -> Result<Value, String> {
    match name {
        "team_send" => team_send(hub, ctx, args).await,
        "team_read" => team_read(hub, ctx, args).await,
        "team_info" => team_info(hub, ctx).await,
        "team_status" => Ok(json!({ "success": true })),
        "team_assign_task" => team_assign_task(hub, ctx, args).await,
        "team_get_tasks" => team_get_tasks(hub, ctx).await,
        "team_update_task" => team_update_task(hub, ctx, args).await,
        "team_recruit" => team_recruit(hub, ctx, args).await,
        "team_dismiss" => team_dismiss(hub, ctx, args).await,
        "team_list_role_profiles" => team_list_role_profiles(hub).await,
        other => Err(format!("Unknown tool: {other}")),
    }
}

/// caller の role が要求された permission を持つか検証する。
/// renderer が同期した role_profile_summary を参照。
async fn caller_has_permission(
    hub: &TeamHub,
    caller_role: &str,
    perm: &str,
) -> bool {
    let summary = hub.get_role_profile_summary().await;
    if let Some(p) = summary.iter().find(|p| p.id == caller_role) {
        match perm {
            "canRecruit" => p.can_recruit,
            "canDismiss" => p.can_dismiss,
            "canAssignTasks" => p.can_assign_tasks,
            _ => false,
        }
    } else {
        // role_profile が summary に無い (古い builtin 等) → 安全側で false。
        // ただし後方互換のため、leader だけは canRecruit/canDismiss を許可する。
        match (caller_role, perm) {
            ("leader", "canRecruit") => true,
            ("leader", "canDismiss") => true,
            ("leader", "canAssignTasks") => true,
            _ => false,
        }
    }
}

/// team_recruit: 新メンバーをチームに追加する。Renderer に event::emit でカード生成を依頼し、
/// その新 agentId が handshake してくるまで oneshot で待機 (timeout 30s)。
async fn team_recruit(hub: &TeamHub, ctx: &CallContext, args: &Value) -> Result<Value, String> {
    if !caller_has_permission(hub, &ctx.role, "canRecruit").await {
        return Err(format!(
            "permission denied: role '{}' cannot recruit",
            ctx.role
        ));
    }
    let role_profile_id = args
        .get("role_profile_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if role_profile_id.is_empty() {
        return Err("role_profile_id is required".into());
    }
    let engine = args
        .get("engine")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let agent_label_hint = args
        .get("agent_label_hint")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let custom_instructions = args
        .get("custom_instructions")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // role profile の検証 (summary から)
    let summary = hub.get_role_profile_summary().await;
    let target = summary
        .iter()
        .find(|p| p.id == role_profile_id)
        .ok_or_else(|| format!("unknown role_profile_id: {role_profile_id}"))?;

    // singleton 検証 (同 role が既に居たら拒否)
    if target.singleton {
        let members = hub.registry.list_team_members(&ctx.team_id);
        if members.iter().any(|(_, role)| role == &role_profile_id) {
            return Err(format!(
                "singleton role '{role_profile_id}' is already filled in this team"
            ));
        }
    }

    // チーム上限
    let current_count = hub.registry.list_team_members(&ctx.team_id).len();
    if current_count >= MAX_MEMBERS_PER_TEAM {
        return Err(format!(
            "team is full ({current_count}/{MAX_MEMBERS_PER_TEAM} members)"
        ));
    }

    // engine: 引数省略時は role profile の default
    let resolved_engine = if engine.is_empty() {
        target.default_engine.clone()
    } else {
        engine
    };

    // 新 agentId を採番 (vc- prefix で他システムと区別)
    let new_agent_id = format!("vc-{}", Uuid::new_v4());

    // pending に登録
    let rx = hub.register_pending_recruit(new_agent_id.clone()).await;

    // Renderer にカード生成を依頼
    let app = hub.app_handle.lock().await.clone();
    if let Some(app) = &app {
        let payload = json!({
            "teamId": ctx.team_id,
            "requesterAgentId": ctx.agent_id,
            "requesterRole": ctx.role,
            "newAgentId": new_agent_id,
            "roleProfileId": role_profile_id,
            "engine": resolved_engine,
            "agentLabelHint": agent_label_hint,
            "customInstructions": custom_instructions,
        });
        if let Err(e) = app.emit("team:recruit-request", payload) {
            hub.cancel_pending_recruit(&new_agent_id).await;
            return Err(format!("failed to emit recruit-request: {e}"));
        }
    } else {
        hub.cancel_pending_recruit(&new_agent_id).await;
        return Err("renderer not available (canvas mode required)".into());
    }

    // handshake 完了を待つ
    match tokio::time::timeout(RECRUIT_TIMEOUT, rx).await {
        Ok(Ok(outcome)) => Ok(json!({
            "success": true,
            "agentId": outcome.agent_id,
            "roleProfileId": outcome.role_profile_id,
        })),
        Ok(Err(_)) => {
            // sender dropped
            Err("recruit cancelled".into())
        }
        Err(_) => {
            // timeout
            hub.cancel_pending_recruit(&new_agent_id).await;
            // renderer にも cancel イベントを emit してカードを撤収させる
            if let Some(app) = &app {
                let _ = app.emit(
                    "team:recruit-cancelled",
                    json!({ "newAgentId": new_agent_id, "reason": "timeout" }),
                );
            }
            Err(format!(
                "recruit timeout (>{}s); the spawned agent failed to handshake",
                RECRUIT_TIMEOUT.as_secs()
            ))
        }
    }
}

async fn team_dismiss(hub: &TeamHub, ctx: &CallContext, args: &Value) -> Result<Value, String> {
    if !caller_has_permission(hub, &ctx.role, "canDismiss").await {
        return Err(format!(
            "permission denied: role '{}' cannot dismiss",
            ctx.role
        ));
    }
    let agent_id = args
        .get("agent_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if agent_id.is_empty() {
        return Err("agent_id is required".into());
    }
    if agent_id == ctx.agent_id {
        return Err("cannot dismiss yourself".into());
    }
    // チーム所属チェック
    let members = hub.registry.list_team_members(&ctx.team_id);
    if !members.iter().any(|(aid, _)| aid == &agent_id) {
        return Err(format!("agent '{agent_id}' is not in this team"));
    }
    // Renderer に閉じてもらう
    let app = hub.app_handle.lock().await.clone();
    if let Some(app) = &app {
        let _ = app.emit(
            "team:dismiss-request",
            json!({ "teamId": ctx.team_id, "agentId": agent_id }),
        );
    }
    Ok(json!({ "success": true, "agentId": agent_id }))
}

async fn team_list_role_profiles(hub: &TeamHub) -> Result<Value, String> {
    let summary = hub.get_role_profile_summary().await;
    Ok(json!({
        "profiles": summary.iter().map(|p| json!({
            "id": p.id,
            "label": p.label_en,
            "labelJa": p.label_ja,
            "description": p.description_en,
            "descriptionJa": p.description_ja,
            "canRecruit": p.can_recruit,
            "canDismiss": p.can_dismiss,
            "canAssignTasks": p.can_assign_tasks,
            "defaultEngine": p.default_engine,
            "singleton": p.singleton,
        })).collect::<Vec<_>>()
    }))
}

async fn team_send(hub: &TeamHub, ctx: &CallContext, args: &Value) -> Result<Value, String> {
    let to = args.get("to").and_then(|v| v.as_str()).unwrap_or("");
    let message = args.get("message").and_then(|v| v.as_str()).unwrap_or("");
    if to.is_empty() || message.is_empty() {
        return Err("to and message are required".into());
    }

    // メッセージ履歴に追加
    let timestamp = Utc::now().to_rfc3339();
    let mut state = hub.state.lock().await;
    let team = state
        .teams
        .entry(ctx.team_id.clone())
        .or_insert_with(|| crate::team_hub::TeamInfo {
            id: ctx.team_id.clone(),
            ..Default::default()
        });
    let msg_id = (team.messages.len() + 1) as u32;
    team.messages.push(TeamMessage {
        id: msg_id,
        from: ctx.role.clone(),
        from_agent_id: ctx.agent_id.clone(),
        to: to.to_string(),
        message: message.to_string(),
        timestamp: timestamp.clone(),
        read_by: vec![ctx.agent_id.clone()],
    });
    drop(state);

    // 宛先 PTY に inject
    let registry = hub.registry.clone();
    let team_members = registry.list_team_members(&ctx.team_id);
    let mut delivered = vec![];
    let preview: String = message.chars().take(80).collect();
    let app = hub.app_handle.lock().await.clone();
    for (target_aid, target_role) in team_members {
        if target_aid == ctx.agent_id {
            continue;
        }
        if to == "all" || to == target_role {
            if inject::inject(registry.clone(), &target_aid, &ctx.role, message).await {
                delivered.push(if target_role.is_empty() {
                    target_aid.clone()
                } else {
                    target_role.clone()
                });
                // read_by に追加
                {
                    let mut state = hub.state.lock().await;
                    if let Some(t) = state.teams.get_mut(&ctx.team_id) {
                        if let Some(m) = t.messages.iter_mut().find(|m| m.id == msg_id) {
                            m.read_by.push(target_aid.clone());
                        }
                    }
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
    }

    let note = if delivered.is_empty() {
        "宛先のエージェントが見つからないか、現在オンラインではありません。".to_string()
    } else {
        format!("{} 名に直接配信しました。", delivered.len())
    };
    Ok(json!({
        "success": true,
        "messageId": msg_id,
        "delivered": delivered,
        "note": note,
    }))
}

async fn team_read(hub: &TeamHub, ctx: &CallContext, args: &Value) -> Result<Value, String> {
    let unread_only = args
        .get("unread_only")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let mut state = hub.state.lock().await;
    let team = state
        .teams
        .entry(ctx.team_id.clone())
        .or_insert_with(|| crate::team_hub::TeamInfo {
            id: ctx.team_id.clone(),
            ..Default::default()
        });
    let mut out = vec![];
    for m in team.messages.iter_mut() {
        let is_for_me = m.to == "all" || m.to == ctx.role;
        let not_from_me = m.from_agent_id != ctx.agent_id;
        if !is_for_me || !not_from_me {
            continue;
        }
        if unread_only && m.read_by.contains(&ctx.agent_id) {
            continue;
        }
        if !m.read_by.contains(&ctx.agent_id) {
            m.read_by.push(ctx.agent_id.clone());
        }
        out.push(json!({
            "id": m.id,
            "from": m.from,
            "message": m.message,
            "timestamp": m.timestamp,
        }));
    }
    let count = out.len();
    Ok(json!({ "messages": out, "count": count }))
}

async fn team_info(hub: &TeamHub, ctx: &CallContext) -> Result<Value, String> {
    let state = hub.state.lock().await;
    let name = state
        .teams
        .get(&ctx.team_id)
        .map(|t| t.name.clone())
        .unwrap_or_default();
    drop(state);
    let members: Vec<_> = hub
        .registry
        .list_team_members(&ctx.team_id)
        .into_iter()
        .map(|(aid, role)| json!({ "role": role, "agentId": aid, "online": true }))
        .collect();
    Ok(json!({
        "teamId": ctx.team_id,
        "teamName": name,
        "myRole": ctx.role,
        "myAgentId": ctx.agent_id,
        "members": members,
    }))
}

async fn team_assign_task(
    hub: &TeamHub,
    ctx: &CallContext,
    args: &Value,
) -> Result<Value, String> {
    let assignee = args.get("assignee").and_then(|v| v.as_str()).unwrap_or("");
    let description = args.get("description").and_then(|v| v.as_str()).unwrap_or("");
    if assignee.is_empty() || description.is_empty() {
        return Err("assignee and description are required".into());
    }
    let task_id;
    let timestamp = Utc::now().to_rfc3339();
    {
        let mut state = hub.state.lock().await;
        let team = state
            .teams
            .entry(ctx.team_id.clone())
            .or_insert_with(|| crate::team_hub::TeamInfo {
                id: ctx.team_id.clone(),
                ..Default::default()
            });
        task_id = (team.tasks.len() + 1) as u32;
        team.tasks.push(TeamTask {
            id: task_id,
            assigned_to: assignee.to_string(),
            description: description.to_string(),
            status: "pending".into(),
            created_by: ctx.role.clone(),
            created_at: timestamp,
        });
    }
    // 通知を team_send 経由で送る
    let notify_args = json!({ "to": assignee, "message": format!("[Task #{task_id}] {description}") });
    let _ = team_send(hub, ctx, &notify_args).await;
    Ok(json!({ "success": true, "taskId": task_id }))
}

async fn team_get_tasks(hub: &TeamHub, ctx: &CallContext) -> Result<Value, String> {
    let state = hub.state.lock().await;
    let tasks = state
        .teams
        .get(&ctx.team_id)
        .map(|t| {
            t.tasks
                .iter()
                .map(|x| {
                    json!({
                        "id": x.id,
                        "assignedTo": x.assigned_to,
                        "description": x.description,
                        "status": x.status,
                        "createdBy": x.created_by,
                        "createdAt": x.created_at,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(json!({ "tasks": tasks }))
}

async fn team_update_task(
    hub: &TeamHub,
    ctx: &CallContext,
    args: &Value,
) -> Result<Value, String> {
    let task_id = args.get("task_id").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let status = args.get("status").and_then(|v| v.as_str()).unwrap_or("");
    let mut state = hub.state.lock().await;
    let team = state
        .teams
        .get_mut(&ctx.team_id)
        .ok_or_else(|| "Team not found".to_string())?;
    let task = team
        .tasks
        .iter_mut()
        .find(|t| t.id == task_id)
        .ok_or_else(|| format!("Task #{task_id} not found"))?;
    task.status = status.to_string();
    Ok(json!({ "success": true }))
}

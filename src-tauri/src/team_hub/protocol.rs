// MCP JSON-RPC プロトコルハンドラ
//
// 旧 team-hub.ts の handleMcpRequest 等価。
// initialize / tools/list / tools/call (team_send 等 7 ツール) を実装。

use crate::team_hub::{inject, CallContext, TeamHub, TeamMessage, TeamTask};
use chrono::Utc;
use serde_json::{json, Value};
use tauri::Emitter;

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
                "serverInfo": { "name": "vive-team", "version": "2.0.0-rust" }
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
        other => Err(format!("Unknown tool: {other}")),
    }
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

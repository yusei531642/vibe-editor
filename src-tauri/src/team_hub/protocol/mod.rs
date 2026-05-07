//! MCP JSON-RPC プロトコルハンドラ。
//!
//! 旧 team-hub.ts の handleMcpRequest 等価。
//! initialize / tools/list / tools/call (team_send 等 7 ツール + 新 recruit 系) を実装。
//!
//! Issue #373 Phase 2 で `protocol.rs` (1729 行) を以下のサブモジュールに分割:
//! - `consts` — 定数 (タイムアウト / payload 上限)
//! - `schema` — `tools/list` の JSON Schema 定義
//! - `permissions` — `caller_has_permission` / `builtin_role_permission` (security-critical)
//! - `dynamic_role` — `validate_and_register_dynamic_role`
//! - `helpers` — `resolve_targets` / `message_is_for_me` + 11 個の unit test
//! - `tools/{recruit,dismiss,send,read,info,status,assign_task,get_tasks,update_task,
//!    list_role_profiles,diagnostics}` — 各 MCP tool の実装
//!
//! 公開 API は `pub async fn handle()` の 1 つだけ (mod.rs から外部に出る symbol)。

// Issue #511: `team_hub::inject` (sibling) から `INJECT_*` 定数を参照するため、
// 旧 `mod consts` (private) を `team_hub` サブツリー全体に公開する。
// `pub(crate)` まで広げる必要は無く、外部 (commands 等) には依然非可視のまま。
pub(in crate::team_hub) mod consts;
// Issue #513: `state::TeamHub::register_team` (sibling 親 module) から
// `replay_persisted_dynamic_roles_for_team` / `PersistedDynamicRoleEntry` を参照するため、
// `team_hub` サブツリー全体に公開する。`pub(crate)` まで広げる必要は無い。
pub(in crate::team_hub) mod dynamic_role;
mod helpers;
// Issue #519: 動的 instructions の禁止句 lint。recruit 段階で逸脱指示を弾く。
mod instruction_lint;
// Issue #494: `team_hub/tests/permissions.rs` の matrix integration test から
// `check_permission` / `Permission` を参照するため、`team_hub` サブツリー全体に公開する。
// 旧 `mod permissions;` は protocol 内でのみ可視で、外部テストからアクセスできなかった。
pub(in crate::team_hub) mod permissions;
// Issue #508: 動的ロール定義の必須テンプレ + 曖昧名 + Worktree Isolation Rule の validation。
mod role_template;
mod schema;
// Issue #510: tools::diagnostics を `commands/team_diagnostics.rs` (Tauri IPC) から
// 呼び出すため crate 内可視に緩める。renderer は Leader 役で薄い wrapper を介して
// MCP と同一データを取得する。external (extra-crate) 公開は意図しないので `pub(crate)` 維持。
pub(crate) mod tools;

use crate::team_hub::{CallContext, TeamHub};
use schema::tool_defs;
use serde_json::{json, Value};
use tools::{
    team_ack_handoff, team_assign_task, team_create_leader, team_diagnostics, team_dismiss,
    team_get_tasks, team_info, team_list_role_profiles, team_lock_files, team_read, team_recruit,
    team_send, team_status, team_switch_leader, team_unlock_files, team_update_task,
};

pub async fn handle(hub: &TeamHub, ctx: &CallContext, req: &Value) -> Option<Value> {
    let method = req.get("method").and_then(|v| v.as_str()).unwrap_or("");
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let params = req.get("params").cloned().unwrap_or_else(|| json!({}));

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
        // Issue #340: bridge → Hub への keepalive 通知。idle drop を防ぐためだけの no-op。
        // 応答を返すと Claude / Codex の stdout を汚染するので、id 有無に関わらず None を返す。
        "team-hub/keepalive" => None,
        "ping" => Some(json!({ "jsonrpc": "2.0", "id": id, "result": {} })),
        "tools/list" => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": { "tools": if ctx.team_id.is_empty() { json!([]) } else { tool_defs() } }
        })),
        "tools/call" => {
            let tool_name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
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
                Err(msg) => {
                    // Issue #342 Phase 1 (1.7b): 構造化 JSON 文字列を Err に詰めるツール
                    // (現在は team_recruit のみ) が、`json!({"error": msg})` で文字列値として
                    // 二重エスケープされてクライアントが 2 回 parse する必要がある問題を回避。
                    // msg が JSON object として parse できれば object のまま `error` キーに乗せ、
                    // そうでなければ従来どおり文字列値として包む。
                    let text = match serde_json::from_str::<Value>(&msg) {
                        Ok(v) if v.is_object() => json!({ "error": v }).to_string(),
                        _ => json!({ "error": msg }).to_string(),
                    };
                    Some(json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {
                            "content": [
                                { "type": "text", "text": text }
                            ],
                            "isError": true
                        }
                    }))
                }
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
        "team_status" => team_status(hub, ctx, args).await,
        "team_assign_task" => team_assign_task(hub, ctx, args).await,
        "team_get_tasks" => team_get_tasks(hub, ctx).await,
        "team_update_task" => team_update_task(hub, ctx, args).await,
        "team_recruit" => team_recruit(hub, ctx, args).await,
        "team_create_leader" => team_create_leader(hub, ctx, args).await,
        "team_ack_handoff" => team_ack_handoff(hub, ctx, args).await,
        "team_switch_leader" => team_switch_leader(hub, ctx, args).await,
        "team_dismiss" => team_dismiss(hub, ctx, args).await,
        "team_list_role_profiles" => team_list_role_profiles(hub, ctx).await,
        "team_diagnostics" => team_diagnostics(hub, ctx).await,
        // Issue #526: vibe-team の advisory file lock。
        "team_lock_files" => team_lock_files(hub, ctx, args).await,
        "team_unlock_files" => team_unlock_files(hub, ctx, args).await,
        other => Err(format!("Unknown tool: {other}")),
    }
}

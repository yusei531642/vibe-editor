// MCP JSON-RPC プロトコルハンドラ
//
// 旧 team-hub.ts の handleMcpRequest 等価。
// initialize / tools/list / tools/call (team_send 等 7 ツール + 新 recruit 系) を実装。

use crate::team_hub::{inject, CallContext, DynamicRole, TeamHub, TeamMessage, TeamTask};
use chrono::Utc;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::Emitter;
use uuid::Uuid;

const RECRUIT_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_MEMBERS_PER_TEAM: usize = 12;
/// 動的ロール instructions の最大長。Leader が暴走して巨大プロンプトを投げてくるのを抑える。
const MAX_DYNAMIC_INSTRUCTIONS_LEN: usize = 16 * 1024; // 16 KiB
/// 動的ロール label / description の最大長
const MAX_DYNAMIC_LABEL_LEN: usize = 200;
const MAX_DYNAMIC_DESCRIPTION_LEN: usize = 1000;
/// チーム 1 つあたりの動的ロール数上限 (DoS 抑止)
const MAX_DYNAMIC_ROLES_PER_TEAM: usize = 64;
/// Issue #107: team_send 1 message の最大長 (ハードリミット)。これ以上は呼び出し側を拒否する
/// (単に切ると context が崩れて user 体験が悪いので reject に倒す)。
const MAX_MESSAGE_LEN: usize = 64 * 1024; // 64 KiB
/// 「長文ペイロード・ルール」の閾値。これを超えたら `.vibe-team/tmp/<short_id>.md` に
/// 書き出してファイルパスを送るパターンを強制する。
/// inject 側を bracketed-paste 化したので Claude Code は long な貼付けを 1 件として
/// 扱える ようになった。よって閾値は inject の MAX_PAYLOAD と揃えて 32 KiB に拡大。
/// それでも超える本文 (大量の playbook や数十件の YAML) はファイル経由を強制する設計。
const SOFT_PAYLOAD_LIMIT: usize = 32 * 1024;
/// Issue #107: チームごとに保持する message 履歴の上限。超過分は古い順に破棄。
/// 件数ベースで持つことで、Hub の長期常駐でメモリが青天井に伸びるのを防ぐ。
const MAX_MESSAGES_PER_TEAM: usize = 1000;
/// Issue #107: チームごとに保持する task の上限。超過分は古い順に破棄。
const MAX_TASKS_PER_TEAM: usize = 500;

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
            "description":
                "Define a worker role AND hire a member to fill it, in a single step. \
                 Pass role_id + label + description + instructions to create a new dynamic role on the fly; \
                 system-level rules (wait for orders, report via team_send, no polling) are added automatically. \
                 Reuse an existing role_id (e.g. \"leader\", \"hr\", or any role you already created) by omitting label/description/instructions. \
                 See the `vibe-team` Skill for the full team-design playbook.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "role_id": {
                        "type": "string",
                        "description": "Short snake_case identifier (e.g. \"marketing_chief\", \"employee_1\"). Reuses an existing role if it already exists."
                    },
                    "engine": {
                        "type": "string",
                        "enum": ["claude", "codex"],
                        "description": "Engine to run this member on. Pick based on the role's strengths (claude is strongest at coding/long reasoning)."
                    },
                    "label": { "type": "string", "description": "Display name (e.g. \"Marketing Chief\"). Required when role_id is new." },
                    "description": { "type": "string", "description": "One-sentence summary of the role. Required when role_id is new." },
                    "instructions": {
                        "type": "string",
                        "description":
                            "Behavioral instructions specific to this role (mindset, priorities, do/don't). Required when role_id is new. \
                             System rules are added automatically; do NOT repeat them here."
                    },
                    "instructions_ja": { "type": "string", "description": "Optional Japanese version of instructions." },
                    "agent_label_hint": { "type": "string", "description": "Optional override for the canvas card title." }
                },
                "required": ["role_id"]
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
            "description":
                "List all available role profiles (id, label, permissions). Includes both built-in (leader / hr) \
                 and any dynamic roles previously created with team_recruit.",
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
        "team_list_role_profiles" => team_list_role_profiles(hub, ctx).await,
        other => Err(format!("Unknown tool: {other}")),
    }
}

/// Issue #136 (Security): caller の role が要求された permission を持つか検証する。
///
/// 旧実装は renderer から同期された `role_profile_summary` の can_* フラグを SSOT に
/// していた。renderer 内コード実行 (XSS 等) を獲得した攻撃者が任意 role に
/// canRecruit/canCreateRoleProfile=true を仕込んだ summary を Hub に同期し、
/// 任意 system prompt の worker を spawn できる権限昇格経路があった。
///
/// 修正方針: permission は Rust 側の immutable builtin テーブルだけを参照し、
/// renderer の summary は UI label/desc 等の表示用途に限定する。動的 role は
/// 常に can_* = false 扱い (recruit / dismiss / role 作成は不可)。
async fn caller_has_permission(
    _hub: &TeamHub,
    caller_role: &str,
    perm: &str,
) -> bool {
    builtin_role_permission(caller_role, perm)
}

/// builtin role の hardcoded 権限テーブル。
/// renderer から差し替えられないため、ここで false のロールは絶対に該当 perm を持てない。
fn builtin_role_permission(role: &str, perm: &str) -> bool {
    match (role, perm) {
        // Leader: 全権
        ("leader", "canRecruit") => true,
        ("leader", "canDismiss") => true,
        ("leader", "canAssignTasks") => true,
        ("leader", "canCreateRoleProfile") => true,
        // HR: 採用 + タスク割振 + 動的ロール登録 (Leader 代理として)
        ("hr", "canRecruit") => true,
        ("hr", "canAssignTasks") => true,
        ("hr", "canCreateRoleProfile") => true,
        // 一般ワーカー (planner / programmer / researcher / reviewer 等) はいずれも不可。
        // 動的ロール (renderer が作った任意 id) も match しないので全 false。
        _ => false,
    }
}

/// 動的ロール定義 1 件を検証 + 登録。team_recruit の role_definition / team_create_role の両方から使う。
/// 既存 builtin (summary 上) と被る role_id は拒否、上限超過も拒否、長さ上限も拒否する。
async fn validate_and_register_dynamic_role(
    hub: &TeamHub,
    ctx: &CallContext,
    role_id: &str,
    label: &str,
    description: &str,
    instructions: &str,
    instructions_ja: Option<&str>,
) -> Result<DynamicRole, String> {
    // 権限チェック (Leader だけが動的ロールを作れる)
    if !caller_has_permission(hub, &ctx.role, "canCreateRoleProfile").await {
        return Err(format!(
            "permission denied: role '{}' cannot create role profiles",
            ctx.role
        ));
    }
    // バリデーション: id
    let role_id = role_id.trim();
    if role_id.is_empty() {
        return Err("role_id is required".into());
    }
    if role_id.len() > 80 {
        return Err("role_id is too long (max 80)".into());
    }
    // ASCII alnum + _ - のみ許可 (`vc-` などのプレフィックスとの混同を避ける)
    if !role_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("role_id must contain only ASCII letters, digits, '_' or '-'".into());
    }
    // builtin との衝突 (summary に id が居れば builtin or override)
    let summary = hub.get_role_profile_summary().await;
    if summary.iter().any(|p| p.id == role_id) {
        return Err(format!(
            "role_id '{role_id}' is reserved by a built-in / existing role profile"
        ));
    }
    // 長さ上限
    if label.len() > MAX_DYNAMIC_LABEL_LEN {
        return Err(format!(
            "label too long: {} bytes (limit {})",
            label.len(),
            MAX_DYNAMIC_LABEL_LEN
        ));
    }
    if description.len() > MAX_DYNAMIC_DESCRIPTION_LEN {
        return Err(format!(
            "description too long: {} bytes (limit {})",
            description.len(),
            MAX_DYNAMIC_DESCRIPTION_LEN
        ));
    }
    if instructions.len() > MAX_DYNAMIC_INSTRUCTIONS_LEN {
        return Err(format!(
            "instructions too long: {} bytes (limit {})",
            instructions.len(),
            MAX_DYNAMIC_INSTRUCTIONS_LEN
        ));
    }
    if let Some(ja) = instructions_ja {
        if ja.len() > MAX_DYNAMIC_INSTRUCTIONS_LEN {
            return Err(format!(
                "instructions_ja too long: {} bytes (limit {})",
                ja.len(),
                MAX_DYNAMIC_INSTRUCTIONS_LEN
            ));
        }
    }
    // チームあたりの上限
    let existing = hub.get_dynamic_roles(&ctx.team_id).await;
    if existing.len() >= MAX_DYNAMIC_ROLES_PER_TEAM
        && !existing.iter().any(|r| r.id == role_id)
    {
        return Err(format!(
            "too many dynamic roles in this team ({}/{} max)",
            existing.len(),
            MAX_DYNAMIC_ROLES_PER_TEAM
        ));
    }
    let role = DynamicRole {
        id: role_id.to_string(),
        label: label.to_string(),
        description: description.to_string(),
        instructions: instructions.to_string(),
        instructions_ja: instructions_ja.map(|s| s.to_string()),
        team_id: ctx.team_id.clone(),
        created_by_role: ctx.role.clone(),
    };
    hub.register_dynamic_role(role.clone()).await;
    // renderer に通知 (UI 更新 + role-profiles-context 内のメモリキャッシュへ反映)
    let app = hub.app_handle.lock().await.clone();
    if let Some(app) = &app {
        let payload = json!({
            "teamId": role.team_id,
            "role": {
                "id": role.id,
                "label": role.label,
                "description": role.description,
                "instructions": role.instructions,
                "instructionsJa": role.instructions_ja,
                "teamId": role.team_id,
                "createdByRole": role.created_by_role,
            }
        });
        if let Err(e) = app.emit("team:role-created", payload) {
            tracing::warn!("emit team:role-created failed: {e}");
        }
    }
    Ok(role)
}

/// team_recruit: 新メンバーをチームに追加する。Renderer に event::emit でカード生成を依頼し、
/// その新 agentId が handshake してくるまで oneshot で待機 (timeout 30s)。
///
/// フラット引数の API:
///   - role_id (必須): snake_case 識別子。既存 (leader/hr/動的ロール) を再利用する場合はこれだけで OK。
///   - engine: claude / codex。省略時は role の default、それも無ければ claude。
///   - label / description / instructions: 揃っていれば「動的ロール定義 + 採用」を 1 コールで実行。
///     既存 role_id と被る場合は「既に存在する」エラーになる。
///   - instructions_ja: 任意の日本語版 instructions。
///   - agent_label_hint: 任意。canvas カードのタイトル上書き。
async fn team_recruit(hub: &TeamHub, ctx: &CallContext, args: &Value) -> Result<Value, String> {
    if !caller_has_permission(hub, &ctx.role, "canRecruit").await {
        return Err(format!(
            "permission denied: role '{}' cannot recruit",
            ctx.role
        ));
    }
    // role_id を主引数とする。後方互換のため `role_profile_id` も受け付ける。
    let role_profile_id = args
        .get("role_id")
        .and_then(|v| v.as_str())
        .or_else(|| args.get("role_profile_id").and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string();
    if role_profile_id.is_empty() {
        return Err("role_id is required".into());
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

    // フラット引数で動的ロール定義が同梱されているか判定。
    // label / description / instructions が「いずれか」あれば「全て揃っている必要がある」とみなしてバリデート。
    let label = args
        .get("label")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let description = args
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let instructions = args
        .get("instructions")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let instructions_ja = args
        .get("instructions_ja")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let any_def_field =
        !label.is_empty() || !description.is_empty() || !instructions.is_empty();
    let all_def_fields =
        !label.is_empty() && !description.is_empty() && !instructions.is_empty();
    if any_def_field && !all_def_fields {
        return Err(
            "to define a new role, all of label / description / instructions must be provided".into(),
        );
    }

    // 動的ロール定義が揃っていれば「設計 + 採用」を 1 ステップで実行。
    // - Leader が「役職を考える」と「採用する」を別ターンで分けると LLM の往復が増えてエラーが増える。
    //   1 コール完結にすることで、Leader の発話オーバーヘッドとエラーリスクを最小化する。
    let dynamic_role: Option<DynamicRole> = if all_def_fields {
        Some(
            validate_and_register_dynamic_role(
                hub,
                ctx,
                &role_profile_id,
                &label,
                &description,
                &instructions,
                instructions_ja.as_deref(),
            )
            .await?,
        )
    } else {
        None
    };

    // role profile の検証: builtin (summary) もしくは team スコープの動的ロールに在籍していること。
    let summary = hub.get_role_profile_summary().await;
    let summary_match = summary.iter().find(|p| p.id == role_profile_id).cloned();
    let dynamic_match = if summary_match.is_none() {
        // role_definition で今 register したばかりなら dynamic_role にも入っているし、
        // 過去の team_create_role による既存ロールもここに含まれる
        hub.get_dynamic_role(&ctx.team_id, &role_profile_id).await
    } else {
        None
    };
    if summary_match.is_none() && dynamic_match.is_none() {
        return Err(format!(
            "unknown role_profile_id: {role_profile_id} (call team_create_role first, or pass role_definition to team_recruit)"
        ));
    }

    // singleton / default_engine は builtin にしか無いので summary 側だけで判定する
    let target = summary_match.as_ref();
    let is_singleton = target.map(|t| t.singleton).unwrap_or(false);

    // engine: 引数省略時は role profile の default。動的ロールは builtin と違い default を持たないので claude を既定にする。
    let resolved_engine = if engine.is_empty() {
        target
            .map(|t| t.default_engine.clone())
            .unwrap_or_else(|| "claude".to_string())
    } else {
        engine
    };

    // 動的ロールの場合は agent_label_hint をロール label で補完する (renderer 側カード表示が綺麗になる)
    let agent_label_hint = if agent_label_hint.is_empty() {
        if let Some(d) = &dynamic_role {
            d.label.clone()
        } else if let Some(d) = &dynamic_match {
            d.label.clone()
        } else {
            String::new()
        }
    } else {
        agent_label_hint
    };

    // 新 agentId を採番 (vc- prefix で他システムと区別)
    let new_agent_id = format!("vc-{}", Uuid::new_v4());

    // Issue #122: 「singleton / 人数上限チェック」と「pending 登録」を同じクリティカルセクションで実行。
    // pending recruit も人数 / role 重複の判定対象に含めることで、並行 team_recruit が
    // 両方 pass して上限超過 / singleton 重複が発生する競合を防ぐ。
    let current_members = hub.registry.list_team_members(&ctx.team_id);
    let rx = match hub
        .try_register_pending_recruit(
            new_agent_id.clone(),
            ctx.team_id.clone(),
            role_profile_id.clone(),
            is_singleton,
            &current_members,
            MAX_MEMBERS_PER_TEAM,
        )
        .await
    {
        Ok(rx) => rx,
        Err(e) => return Err(e),
    };

    // 動的ロールであれば、その定義もペイロードに同梱する。renderer 側はこの payload を見て
     // RoleProfilesContext のメモリキャッシュへ追加し、worker template に instructions を流し込む。
    // (team:role-created を別 emit でも届けているが、recruit-request と同梱しておくと到達順に依存しない)
    let dynamic_role_payload = match (&dynamic_role, &dynamic_match) {
        (Some(d), _) | (_, Some(d)) => Some(json!({
            "id": d.id,
            "label": d.label,
            "description": d.description,
            "instructions": d.instructions,
            "instructionsJa": d.instructions_ja,
        })),
        _ => None,
    };

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
            "dynamicRole": dynamic_role_payload,
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

async fn team_list_role_profiles(hub: &TeamHub, ctx: &CallContext) -> Result<Value, String> {
    let summary = hub.get_role_profile_summary().await;
    let dynamic = hub.get_dynamic_roles(&ctx.team_id).await;
    let mut profiles: Vec<Value> = summary
        .iter()
        .map(|p| {
            json!({
                "id": p.id,
                "label": p.label_en,
                "labelJa": p.label_ja,
                "description": p.description_en,
                "descriptionJa": p.description_ja,
                "canRecruit": p.can_recruit,
                "canDismiss": p.can_dismiss,
                "canAssignTasks": p.can_assign_tasks,
                "canCreateRoleProfile": p.can_create_role_profile,
                "defaultEngine": p.default_engine,
                "singleton": p.singleton,
                "source": "builtin",
            })
        })
        .collect();
    // 同じ team で動的に作られたロールも返す。Leader の team_create_role 後に
    // HR が team_list_role_profiles を呼ぶフローで重要。
    for d in &dynamic {
        profiles.push(json!({
            "id": d.id,
            "label": d.label,
            "description": d.description,
            "canRecruit": false,
            "canDismiss": false,
            "canAssignTasks": false,
            "canCreateRoleProfile": false,
            "defaultEngine": "claude",
            "singleton": false,
            "source": "dynamic",
        }));
    }
    Ok(json!({ "profiles": profiles }))
}

async fn team_send(hub: &TeamHub, ctx: &CallContext, args: &Value) -> Result<Value, String> {
    let to = args.get("to").and_then(|v| v.as_str()).unwrap_or("");
    let message = args.get("message").and_then(|v| v.as_str()).unwrap_or("");
    if to.is_empty() || message.is_empty() {
        return Err("to and message are required".into());
    }
    // Issue #107: 1 メッセージのハードリミット超過は拒否 (途中で truncate すると意味が壊れる)
    if message.len() > MAX_MESSAGE_LEN {
        return Err(format!(
            "message too large: {} bytes (limit {} bytes)",
            message.len(),
            MAX_MESSAGE_LEN
        ));
    }
    // 「長文ペイロード・ルール」: SOFT_PAYLOAD_LIMIT 超過は弾いてファイル経由を強制する。
    // PTY 注入のチャンク分割や受信側 Claude 入力制限で truncate しやすいので、
    // 「2000 文字超は .vibe-team/tmp/<short_id>.md に書き出してパスを送る」設計に倒す。
    if message.len() > SOFT_PAYLOAD_LIMIT {
        return Err(format!(
            "message exceeds the long-payload threshold ({} > {} bytes). \
             Write the full content to `.vibe-team/tmp/<short_id>.md` with the Write tool, \
             then call team_send again with a brief summary plus the file path. \
             (Inline messages up to 32 KiB are now delivered via bracketed paste, but anything \
             beyond that should still be passed by file path.)",
            message.len(),
            SOFT_PAYLOAD_LIMIT
        ));
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
    // Issue #115: messages.len()+1 だと履歴上限到達後に id が固定して衝突する。
    // 単調増加カウンタにすることで上限を超えても一意性を保つ。
    team.next_message_id = team.next_message_id.saturating_add(1);
    let msg_id = team.next_message_id;
    team.messages.push(TeamMessage {
        id: msg_id,
        from: ctx.role.clone(),
        from_agent_id: ctx.agent_id.clone(),
        to: to.to_string(),
        message: message.to_string(),
        timestamp: timestamp.clone(),
        read_by: vec![ctx.agent_id.clone()],
    });
    // Issue #107: 上限超過分は古い順に破棄してメモリ青天井を防ぐ。
    // Vec::remove(0) は O(n) だが MAX_MESSAGES_PER_TEAM 程度なら許容できる。
    while team.messages.len() > MAX_MESSAGES_PER_TEAM {
        team.messages.remove(0);
    }
    drop(state);

    // Issue #150: 宛先メンバーへの inject を並列実行する。
    // 旧実装はメンバーごとに inject().await を直列で回し、to=all + 6 メンバー +
    // 4KB メッセージで 6 秒間 RPC を握りっぱなしになっていた (sleep 15ms × 64chunk × 6人)。
    // → 各宛先を tokio::spawn で並列発火して JoinSet で集約する。
    let registry = hub.registry.clone();
    let team_members = registry.list_team_members(&ctx.team_id);
    let preview: String = message.chars().take(80).collect();
    let app = hub.app_handle.lock().await.clone();

    let mut targets: Vec<(String, String)> = Vec::new();
    for (target_aid, target_role) in team_members {
        if target_aid == ctx.agent_id {
            continue;
        }
        if to == "all" || to == target_role {
            targets.push((target_aid, target_role));
        }
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
    // Issue #114: 旧実装は assignee / description の空チェックだけで権限を見ておらず、
    // canAssignTasks=false のロールでも task を作成できてしまっていた。先頭で必ず権限検証する。
    if !caller_has_permission(hub, &ctx.role, "canAssignTasks").await {
        return Err(format!(
            "permission denied: role '{}' cannot assign tasks",
            ctx.role
        ));
    }
    let assignee = args.get("assignee").and_then(|v| v.as_str()).unwrap_or("");
    let description = args.get("description").and_then(|v| v.as_str()).unwrap_or("");
    if assignee.is_empty() || description.is_empty() {
        return Err("assignee and description are required".into());
    }
    // 「長文ペイロード・ルール」: description も SOFT_PAYLOAD_LIMIT で弾いてファイル経由を強制。
    // bulk な指示 (21 連続 issue 起票の YAML 等) はここで必ず途中切れしないために。
    if description.len() > SOFT_PAYLOAD_LIMIT {
        return Err(format!(
            "description exceeds the long-payload threshold ({} > {} bytes). \
             Write the full task brief to `.vibe-team/tmp/<short_id>.md` with the Write tool first, \
             then call team_assign_task again with a brief summary plus the file path \
             (e.g. \"21 件起票。詳細は .vibe-team/tmp/issue_bulk.md を参照\"). \
             (Inline descriptions up to 32 KiB are now delivered via bracketed paste, but anything \
             beyond that should still be passed by file path.)",
            description.len(),
            SOFT_PAYLOAD_LIMIT
        ));
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
        // Issue #116: tasks.len()+1 だと履歴上限到達後に id が固定して衝突する。
        // 単調増加カウンタで一意性を保つ。
        team.next_task_id = team.next_task_id.saturating_add(1);
        task_id = team.next_task_id;
        team.tasks.push(TeamTask {
            id: task_id,
            assigned_to: assignee.to_string(),
            description: description.to_string(),
            status: "pending".into(),
            created_by: ctx.role.clone(),
            created_at: timestamp,
        });
        // Issue #107: tasks も件数上限で古い順に破棄
        while team.tasks.len() > MAX_TASKS_PER_TEAM {
            team.tasks.remove(0);
        }
    }
    // Issue #172: 通知の team_send を await せず fire-and-forget でバックグラウンド spawn する。
    // assignee="all" のとき fan-out で sleep 累積して MCP RPC を秒単位でブロックしていたのを解消。
    // 配信失敗のときも呼び出し側 (Leader) には task 作成結果だけを即返す。
    let notify_args = json!({ "to": assignee, "message": format!("[Task #{task_id}] {description}") });
    let hub_clone = hub.clone();
    let ctx_clone = ctx.clone();
    tokio::spawn(async move {
        let _ = team_send(&hub_clone, &ctx_clone, &notify_args).await;
    });
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

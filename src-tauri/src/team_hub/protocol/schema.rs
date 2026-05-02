//! MCP `tools/list` で返す JSON Schema 定義一式。
//!
//! Issue #373 Phase 2 で `protocol.rs` から切り出し。
//!
//! 各 tool 名 / description / inputSchema は逐字保持 (renderer / Claude Code / Codex
//! 側の MCP クライアントが文字列マッチに依存する可能性があるため、改変禁止)。

use serde_json::{json, Value};

pub(super) fn tool_defs() -> Value {
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
            "description":
                "Record your current status so the Leader can tell you are alive and what you are doing. \
                 Stored on the Hub and surfaced via team_diagnostics (currentStatus / lastStatusAt). \
                 Send a short 1-line update on every meaningful step (e.g. \"ACK: starting clone\", \
                 \"running cargo test\", \"waiting on review\") — call frequently for long-running work \
                 so the Leader does not mistake silence for a hang.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "status": {
                        "type": "string",
                        "description": "One short line describing what you are currently doing (non-empty)."
                    }
                },
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
            "name": "team_diagnostics",
            "description":
                "(leader / hr only) Return per-member diagnostic timestamps (recruitedAt, lastHandshakeAt, lastSeenAt, lastMessageInAt/OutAt) and counters (messagesIn/Out, tasksClaimed) plus the server log file path. Use this to debug 'online but silent' members and to reconstruct incident timelines.",
            "inputSchema": { "type": "object", "properties": {} }
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

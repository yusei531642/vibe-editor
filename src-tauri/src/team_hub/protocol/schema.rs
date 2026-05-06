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
            "description": "Send a message directly into another team member's terminal. The response reports delivery to the terminal (deliveredAtPerRecipient), not that the recipient read or acknowledged it; use team_read / team_update_task / team_status and team_diagnostics pendingInbox fields to confirm agent activity.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "to": { "type": "string" },
                    "message": { "type": "string" },
                    "handoff_id": {
                        "type": "string",
                        "description": "Optional handoff id. When delivery succeeds, the handoff lifecycle is marked injected."
                    }
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
                    "status": { "type": "string" },
                    "summary": { "type": "string" },
                    "blocked_reason": { "type": "string" },
                    "next_action": { "type": "string" },
                    "artifact_path": { "type": "string" },
                    "blocked_by_human_gate": { "type": "boolean" },
                    "required_human_decision": { "type": "string" },
                    "report_kind": { "type": "string" }
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
                        "description": "Engine to run this member on. Pick based on the role's strengths. If the user requested Codex-only, multiple Codex, or a same-engine organization, do not omit this field: pass codex for HR and every recruited worker unless the user explicitly asks to mix Claude."
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
            "name": "team_create_leader",
            "description":
                "(leader only) Create a NEW leader on the same team for a handoff transition. \
                 Bypasses the normal singleton-leader constraint so the old and new leaders coexist briefly. \
                 Used by the canvas \"引き継ぎ\" button: 1) save handoff document, 2) call team_create_leader, \
                 3) wait for the new leader to read the handoff, 4) call team_switch_leader to retire yourself. \
                 Returns the new leader's agentId once it has handshaked.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "engine": {
                        "type": "string",
                        "enum": ["claude", "codex"],
                        "description": "Engine to run the new leader on. Defaults to the leader profile's default (claude)."
                    },
                    "agent_label_hint": {
                        "type": "string",
                        "description": "Optional canvas card title override for the new leader."
                    },
                    "handoff_id": {
                        "type": "string",
                        "description": "Optional handoff id to record replacement leader creation against."
                    }
                }
            }
        },
        {
            "name": "team_ack_handoff",
            "description":
                "(leader only) Mark a handoff document as read and acknowledged by the current leader. \
                 Call this after reading the handoff markdown and before asking the old leader to retire.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "handoff_id": {
                        "type": "string",
                        "description": "handoff id from the markdown or team_create_leader/team_send arguments."
                    },
                    "note": {
                        "type": "string",
                        "description": "Optional one-line acknowledgement note."
                    }
                },
                "required": ["handoff_id"]
            }
        },
        {
            "name": "team_switch_leader",
            "description":
                "(leader only) Promote a previously-spawned leader (see team_create_leader) to active leader, \
                 then retire yourself. The Hub routes role-targeted leader messages to new_leader_agent_id from \
                 this point on. Your card is scheduled to close ~2 seconds later so this MCP response can be \
                 delivered first. Pass close_old_card=false if you want to keep your card open (e.g. for review).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "new_leader_agent_id": {
                        "type": "string",
                        "description": "agentId returned by team_create_leader. Must be in the same team and have role=leader."
                    },
                    "close_old_card": {
                        "type": "boolean",
                        "default": true,
                        "description": "If true (default), the caller's canvas card is retired ~2s after this call returns."
                    },
                    "handoff_id": {
                        "type": "string",
                        "description": "Optional handoff id to mark retired after active leader switch."
                    }
                },
                "required": ["new_leader_agent_id"]
            }
        },
        {
            "name": "team_diagnostics",
            "description":
                "(leader / hr only) Return per-member diagnostic timestamps (recruitedAt, lastHandshakeAt, lastSeenAt/lastAgentActivityAt, lastMessageInAt/OutAt), counters (messagesIn/Out, tasksClaimed), pendingInbox IDs, pendingInboxCount, oldestPendingInboxAgeMs, stalledInbound, and the server log file path. Use this to debug delivered-but-unread messages and 'online but silent' members.",
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

use serde::{Deserialize, Serialize};

pub const SESSION_SCHEMA_VERSION: u32 = 1;
pub const MAX_AUTO_DEPTH: u32 = 3;
pub const MAX_AUTO_TURNS_PER_CHAIN: u32 = 6;
pub const MAX_SKILL_BYTES: usize = 48 * 1024;
pub const MAX_MESSAGE_BYTES: usize = 128 * 1024;

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
pub(super) struct ApiAgentStreamEvent {
    pub session_id: String,
    pub card_instance_id: String,
    pub generation_id: String,
    pub delta: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ApiAgentToolEvent {
    pub session_id: String,
    pub card_instance_id: String,
    pub generation_id: String,
    pub name: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ApiAgentDoneEvent {
    pub session_id: String,
    pub card_instance_id: String,
    pub generation_id: String,
    pub message: ApiAgentMessage,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<ApiAgentUsage>,
    pub stop_reason: String,
    pub turn_count: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ApiAgentErrorEvent {
    pub session_id: String,
    pub card_instance_id: String,
    pub generation_id: String,
    pub message: String,
}

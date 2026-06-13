use crate::commands::error::{CommandError, CommandResult};
use serde_json::{json, Value};

use super::types::{ApiAgentConfig, ApiAgentMessage, ApiAgentUsage};

static HTTP_CLIENT: once_cell::sync::Lazy<reqwest::Client> =
    once_cell::sync::Lazy::new(reqwest::Client::new);

#[derive(Clone)]
pub(super) struct ProviderPreset {
    pub adapter: &'static str,
    pub base_url: String,
    pub supports_tools: bool,
}

pub(super) fn provider_preset(
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

pub(super) async fn call_provider(
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preset_maps_known_providers_to_adapter_and_base_url() {
        let openai = provider_preset("openai", None).unwrap();
        assert_eq!(openai.adapter, "openai-compatible");
        assert_eq!(openai.base_url, "https://api.openai.com/v1");
        assert!(openai.supports_tools);

        let anthropic = provider_preset("anthropic", None).unwrap();
        assert_eq!(anthropic.adapter, "anthropic");
        assert!(anthropic.supports_tools);

        let gemini = provider_preset("gemini", None).unwrap();
        assert_eq!(gemini.adapter, "gemini");

        // tool calling 非対応として扱う preset
        let groq = provider_preset("groq", None).unwrap();
        assert!(!groq.supports_tools);
    }

    #[test]
    fn preset_trims_trailing_slash_on_base_url() {
        let custom = provider_preset("custom-openai-compatible", Some("https://x.example/v1/"))
            .unwrap();
        assert_eq!(custom.base_url, "https://x.example/v1");
        assert_eq!(custom.adapter, "openai-compatible");
    }

    #[test]
    fn custom_provider_requires_base_url() {
        assert!(provider_preset("custom-openai-compatible", None).is_err());
        assert!(provider_preset("custom-openai-compatible", Some("   ")).is_err());
    }

    #[test]
    fn unknown_provider_is_rejected() {
        assert!(provider_preset("does-not-exist", None).is_err());
    }
}

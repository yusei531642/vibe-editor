use crate::commands::error::{CommandError, CommandResult};
use serde_json::{json, Value};

use super::types::{ApiAgentConfig, ApiAgentMessage, ApiAgentUsage};

mod agentic;

pub(super) static HTTP_CLIENT: once_cell::sync::Lazy<reqwest::Client> =
    once_cell::sync::Lazy::new(reqwest::Client::new);

/// tool-calling を有効にして呼ぶときのコンテキスト。`None` のときは read-only chat
/// (SSE ストリーミング) 経路になる。
pub(super) struct ToolRuntime<'a> {
    /// ツールが参照する active project root (state の信頼値)。
    pub project_root: &'a str,
    /// 自動 tool ターンの上限。
    pub max_turns: u32,
    /// tool 実行状況の通知 (name, status, detail)。
    pub on_tool: &'a mut (dyn FnMut(&str, &str, Option<&str>) + Send),
}

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

/// provider を呼び出す。
/// - `tools = Some(..)`: 非ストリーミングの tool-calling ループ (read_file / list_dir を実行)。
/// - `tools = None`: read-only chat を SSE ストリーミング。
///
/// いずれも `on_delta` で本文を emit し、戻り値は確定後の (全文, usage, stop_reason)。
pub(super) async fn call_provider(
    provider: &ProviderPreset,
    key: &str,
    agent: &ApiAgentConfig,
    system_prompt: &str,
    messages: &[ApiAgentMessage],
    tools: Option<ToolRuntime<'_>>,
    on_delta: &mut (dyn FnMut(&str) + Send),
) -> anyhow::Result<(String, Option<ApiAgentUsage>, String)> {
    match (provider.adapter, tools) {
        ("anthropic", Some(rt)) => {
            agentic::call_anthropic_tools(provider, key, agent, system_prompt, messages, rt, on_delta)
                .await
        }
        ("gemini", Some(rt)) => {
            agentic::call_gemini_tools(provider, key, agent, system_prompt, messages, rt, on_delta)
                .await
        }
        (_, Some(rt)) => {
            agentic::call_openai_tools(provider, key, agent, system_prompt, messages, rt, on_delta)
                .await
        }
        ("anthropic", None) => {
            call_anthropic(provider, key, agent, system_prompt, messages, on_delta).await
        }
        ("gemini", None) => {
            call_gemini(provider, key, agent, system_prompt, messages, on_delta).await
        }
        (_, None) => {
            call_openai_compatible(provider, key, agent, system_prompt, messages, on_delta).await
        }
    }
}

async fn call_openai_compatible(
    provider: &ProviderPreset,
    key: &str,
    agent: &ApiAgentConfig,
    system_prompt: &str,
    messages: &[ApiAgentMessage],
    on_delta: &mut (dyn FnMut(&str) + Send),
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
        "stream": true,
        "stream_options": { "include_usage": true }
    });
    if let Some(t) = agent.temperature {
        body["temperature"] = json!(t);
    }
    if let Some(max) = agent.max_output_tokens {
        body["max_tokens"] = json!(max);
    }
    let resp = HTTP_CLIENT
        .post(format!("{}/chat/completions", provider.base_url))
        .bearer_auth(key)
        .json(&body)
        .send()
        .await?
        .error_for_status()?;

    let mut content = String::new();
    let mut usage = None;
    let mut stop = "stop".to_string();
    for_each_sse_data(resp, |data| {
        if data == "[DONE]" {
            return;
        }
        let Ok(v) = serde_json::from_str::<Value>(data) else {
            return;
        };
        if let Some(delta) = v["choices"][0]["delta"]["content"].as_str() {
            if !delta.is_empty() {
                content.push_str(delta);
                on_delta(delta);
            }
        }
        if let Some(fr) = v["choices"][0]["finish_reason"].as_str() {
            stop = fr.to_string();
        }
        if v["usage"].is_object() {
            usage = usage_from_value(&v["usage"]);
        }
    })
    .await?;
    Ok((content, usage, stop))
}

async fn call_anthropic(
    provider: &ProviderPreset,
    key: &str,
    agent: &ApiAgentConfig,
    system_prompt: &str,
    messages: &[ApiAgentMessage],
    on_delta: &mut (dyn FnMut(&str) + Send),
) -> anyhow::Result<(String, Option<ApiAgentUsage>, String)> {
    let req_messages: Vec<Value> = messages
        .iter()
        .filter(|m| m.role == "user" || m.role == "assistant")
        .map(|m| json!({ "role": m.role, "content": m.content }))
        .collect();
    let mut body = json!({
        "model": agent.model,
        "messages": req_messages,
        "max_tokens": agent.max_output_tokens.unwrap_or(4096),
        "stream": true
    });
    if !system_prompt.is_empty() {
        body["system"] = json!(system_prompt);
    }
    if let Some(t) = agent.temperature {
        body["temperature"] = json!(t);
    }
    let resp = HTTP_CLIENT
        .post(format!("{}/messages", provider.base_url))
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await?
        .error_for_status()?;

    let mut content = String::new();
    let mut input_tokens = None;
    let mut output_tokens = None;
    let mut stop = "end_turn".to_string();
    for_each_sse_data(resp, |data| {
        let Ok(v) = serde_json::from_str::<Value>(data) else {
            return;
        };
        match v["type"].as_str() {
            Some("content_block_delta") => {
                if let Some(t) = v["delta"]["text"].as_str() {
                    if !t.is_empty() {
                        content.push_str(t);
                        on_delta(t);
                    }
                }
            }
            Some("message_start") => {
                input_tokens = v["message"]["usage"]["input_tokens"]
                    .as_u64()
                    .map(|n| n as u32);
            }
            Some("message_delta") => {
                if let Some(s) = v["delta"]["stop_reason"].as_str() {
                    stop = s.to_string();
                }
                if let Some(o) = v["usage"]["output_tokens"].as_u64() {
                    output_tokens = Some(o as u32);
                }
            }
            _ => {}
        }
    })
    .await?;
    let usage = Some(ApiAgentUsage {
        input_tokens,
        output_tokens,
        total_tokens: None,
    });
    Ok((content, usage, stop))
}

async fn call_gemini(
    provider: &ProviderPreset,
    key: &str,
    agent: &ApiAgentConfig,
    system_prompt: &str,
    messages: &[ApiAgentMessage],
    on_delta: &mut (dyn FnMut(&str) + Send),
) -> anyhow::Result<(String, Option<ApiAgentUsage>, String)> {
    let mut contents = Vec::new();
    for m in messages {
        if m.role == "system" || m.role == "tool" {
            continue;
        }
        let role = if m.role == "assistant" { "model" } else { "user" };
        contents.push(json!({ "role": role, "parts": [{ "text": m.content }] }));
    }
    let mut body = json!({ "contents": contents });
    if !system_prompt.is_empty() {
        body["systemInstruction"] = json!({ "parts": [{ "text": system_prompt }] });
    }
    let mut gen = serde_json::Map::new();
    if let Some(t) = agent.temperature {
        gen.insert("temperature".to_string(), json!(t));
    }
    if let Some(max) = agent.max_output_tokens {
        gen.insert("maxOutputTokens".to_string(), json!(max));
    }
    if !gen.is_empty() {
        body["generationConfig"] = Value::Object(gen);
    }
    let resp = HTTP_CLIENT
        .post(format!(
            "{}/models/{}:streamGenerateContent?alt=sse",
            provider.base_url, agent.model
        ))
        .header("x-goog-api-key", key)
        .json(&body)
        .send()
        .await?
        .error_for_status()?;

    let mut content = String::new();
    let mut usage = None;
    let mut stop = "STOP".to_string();
    for_each_sse_data(resp, |data| {
        let Ok(v) = serde_json::from_str::<Value>(data) else {
            return;
        };
        if let Some(parts) = v["candidates"][0]["content"]["parts"].as_array() {
            for p in parts {
                if let Some(t) = p["text"].as_str() {
                    if !t.is_empty() {
                        content.push_str(t);
                        on_delta(t);
                    }
                }
            }
        }
        if let Some(fr) = v["candidates"][0]["finishReason"].as_str() {
            stop = fr.to_string();
        }
        if v["usageMetadata"].is_object() {
            usage = Some(ApiAgentUsage {
                input_tokens: v["usageMetadata"]["promptTokenCount"]
                    .as_u64()
                    .map(|n| n as u32),
                output_tokens: v["usageMetadata"]["candidatesTokenCount"]
                    .as_u64()
                    .map(|n| n as u32),
                total_tokens: v["usageMetadata"]["totalTokenCount"]
                    .as_u64()
                    .map(|n| n as u32),
            });
        }
    })
    .await?;
    Ok((content, usage, stop))
}

/// SSE レスポンスを読み、各 `data:` 行の値で `on_data` を呼ぶ。
async fn for_each_sse_data<F: FnMut(&str)>(
    mut resp: reqwest::Response,
    mut on_data: F,
) -> anyhow::Result<()> {
    let mut sse = SseBuffer::default();
    while let Some(chunk) = resp.chunk().await? {
        sse.push(&chunk, &mut on_data);
    }
    sse.flush(&mut on_data);
    Ok(())
}

/// chunk を貯めて完全な行ごとに SSE `data:` ペイロードを取り出すバッファ。
/// マルチバイト文字が chunk 境界で割れても、行 (`\n` 区切り) 単位で decode するため壊れない
/// (改行は UTF-8 の char 境界なので、行バイト列は常に完全な UTF-8 シーケンス)。
#[derive(Default)]
struct SseBuffer {
    buf: Vec<u8>,
}

impl SseBuffer {
    fn push<F: FnMut(&str)>(&mut self, chunk: &[u8], mut on_data: F) {
        self.buf.extend_from_slice(chunk);
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            emit_data_line(&line, &mut on_data);
        }
    }

    /// ストリーム終端で残った (改行無し) 行を flush する。
    fn flush<F: FnMut(&str)>(&mut self, mut on_data: F) {
        if !self.buf.is_empty() {
            let line = std::mem::take(&mut self.buf);
            emit_data_line(&line, &mut on_data);
        }
    }
}

fn emit_data_line<F: FnMut(&str)>(line: &[u8], on_data: &mut F) {
    let line = String::from_utf8_lossy(line);
    let line = line.trim();
    if let Some(rest) = line.strip_prefix("data:") {
        on_data(rest.trim());
    }
}

pub(super) fn usage_from_value(value: &Value) -> Option<ApiAgentUsage> {
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
        let custom =
            provider_preset("custom-openai-compatible", Some("https://x.example/v1/")).unwrap();
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

    fn collect_data(chunks: &[&[u8]]) -> Vec<String> {
        let mut sse = SseBuffer::default();
        let mut out = Vec::new();
        for c in chunks {
            sse.push(c, |d| out.push(d.to_string()));
        }
        sse.flush(|d| out.push(d.to_string()));
        out
    }

    #[test]
    fn sse_buffer_extracts_data_lines() {
        let out = collect_data(&[b"data: hello\n", b"event: x\ndata: world\n\n"]);
        assert_eq!(out, vec!["hello".to_string(), "world".to_string()]);
    }

    #[test]
    fn sse_buffer_reassembles_multibyte_split_across_chunks() {
        // "data: あ\n" を 'あ' (E3 81 82) の途中で分割。行単位 decode で壊れないこと。
        let full = "data: あ\n".as_bytes();
        let (a, b) = full.split_at(7); // "data: " + 'あ' の先頭 1 バイト
        let out = collect_data(&[a, b]);
        assert_eq!(out, vec!["あ".to_string()]);
    }

    #[test]
    fn sse_buffer_flushes_trailing_line_without_newline() {
        let out = collect_data(&[b"data: [DONE]"]);
        assert_eq!(out, vec!["[DONE]".to_string()]);
    }

    #[test]
    fn sse_buffer_ignores_non_data_lines() {
        let out = collect_data(&[b": comment\n", b"\n", b"data: x\n"]);
        assert_eq!(out, vec!["x".to_string()]);
    }
}

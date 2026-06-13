// providers/agentic — 非ストリーミングの tool-calling ループ (Issue #1002)。
//
// tools_enabled (supports_tools && toolMode != readOnly) のとき呼ばれる。tool 解決ターンは
// SSE の差分蓄積を避けるため非ストリーミング (完全 JSON から tool_calls をパース) で回し、
// read_file / list_dir を実行して結果を会話へ戻す。最終回答は on_delta で emit する。
//
// 各 provider のツール表現:
//   - OpenAI:    request.tools[].function / response.message.tool_calls[] / role:"tool"
//   - Anthropic: request.tools[] (input_schema) / content[type=tool_use] / content[type=tool_result]
//   - Gemini:    tools[].functionDeclarations / parts[].functionCall / parts[].functionResponse

use serde_json::{json, Value};

use super::super::tools;
use super::super::types::{ApiAgentConfig, ApiAgentMessage, ApiAgentUsage};
use super::{usage_from_value, ProviderPreset, ToolRuntime, HTTP_CLIENT};

/// 1 件の tool 呼び出し (provider 非依存に正規化したもの)。
struct ToolCall {
    /// OpenAI/Anthropic は id を持つ。Gemini は名前で対応づけるので空。
    id: String,
    name: String,
    args: Value,
}

const BUDGET_MSG: &str = "Tool turn budget exceeded before a final answer.";

// ---------- OpenAI-compatible ----------

pub(super) async fn call_openai_tools(
    provider: &ProviderPreset,
    key: &str,
    agent: &ApiAgentConfig,
    system_prompt: &str,
    messages: &[ApiAgentMessage],
    mut rt: ToolRuntime<'_>,
    on_delta: &mut (dyn FnMut(&str) + Send),
) -> anyhow::Result<(String, Option<ApiAgentUsage>, String)> {
    let specs = tools::builtin_read_tools();
    let tool_defs: Vec<Value> = specs
        .iter()
        .map(|s| {
            json!({
                "type": "function",
                "function": { "name": s.name, "description": s.description, "parameters": s.parameters }
            })
        })
        .collect();

    let mut convo: Vec<Value> = Vec::new();
    if !system_prompt.is_empty() {
        convo.push(json!({ "role": "system", "content": system_prompt }));
    }
    for m in messages {
        if m.role == "tool" {
            continue;
        }
        convo.push(json!({ "role": m.role, "content": m.content }));
    }

    let mut total_usage = None;
    for _turn in 0..rt.max_turns {
        let mut body = json!({
            "model": agent.model,
            "messages": convo,
            "tools": tool_defs,
            "stream": false
        });
        if let Some(t) = agent.temperature {
            body["temperature"] = json!(t);
        }
        if let Some(max) = agent.max_output_tokens {
            body["max_tokens"] = json!(max);
        }
        let v: Value = HTTP_CLIENT
            .post(format!("{}/chat/completions", provider.base_url))
            .bearer_auth(key)
            .json(&body)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        accumulate_usage(&mut total_usage, usage_from_value(&v["usage"]));
        let msg = &v["choices"][0]["message"];
        let stop = v["choices"][0]["finish_reason"]
            .as_str()
            .unwrap_or("stop")
            .to_string();
        let (text, calls) = openai_extract(msg);
        if calls.is_empty() {
            if !text.is_empty() {
                on_delta(&text);
            }
            return Ok((text, total_usage, stop));
        }
        // assistant の tool_calls メッセージをそのまま会話へ (OpenAI は原文の再送が必要)。
        convo.push(msg.clone());
        for call in &calls {
            let outcome = run_tool(&mut rt, call);
            convo.push(json!({
                "role": "tool",
                "tool_call_id": call.id,
                "content": outcome
            }));
        }
    }
    Ok((BUDGET_MSG.to_string(), total_usage, "max_turns".to_string()))
}

fn openai_extract(msg: &Value) -> (String, Vec<ToolCall>) {
    let text = msg["content"].as_str().unwrap_or("").to_string();
    let calls = msg["tool_calls"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|tc| {
                    let id = tc["id"].as_str()?.to_string();
                    let name = tc["function"]["name"].as_str()?.to_string();
                    let args_str = tc["function"]["arguments"].as_str().unwrap_or("{}");
                    let args = serde_json::from_str(args_str).unwrap_or_else(|_| json!({}));
                    Some(ToolCall { id, name, args })
                })
                .collect()
        })
        .unwrap_or_default();
    (text, calls)
}

// ---------- Anthropic ----------

pub(super) async fn call_anthropic_tools(
    provider: &ProviderPreset,
    key: &str,
    agent: &ApiAgentConfig,
    system_prompt: &str,
    messages: &[ApiAgentMessage],
    mut rt: ToolRuntime<'_>,
    on_delta: &mut (dyn FnMut(&str) + Send),
) -> anyhow::Result<(String, Option<ApiAgentUsage>, String)> {
    let specs = tools::builtin_read_tools();
    let tool_defs: Vec<Value> = specs
        .iter()
        .map(|s| json!({ "name": s.name, "description": s.description, "input_schema": s.parameters }))
        .collect();

    let mut convo: Vec<Value> = messages
        .iter()
        .filter(|m| m.role == "user" || m.role == "assistant")
        .map(|m| json!({ "role": m.role, "content": m.content }))
        .collect();

    let mut total_usage = None;
    for _turn in 0..rt.max_turns {
        let mut body = json!({
            "model": agent.model,
            "messages": convo,
            "max_tokens": agent.max_output_tokens.unwrap_or(4096),
            "tools": tool_defs
        });
        if !system_prompt.is_empty() {
            body["system"] = json!(system_prompt);
        }
        if let Some(t) = agent.temperature {
            body["temperature"] = json!(t);
        }
        let v: Value = HTTP_CLIENT
            .post(format!("{}/messages", provider.base_url))
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01")
            .json(&body)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        accumulate_usage(
            &mut total_usage,
            Some(ApiAgentUsage {
                input_tokens: v["usage"]["input_tokens"].as_u64().map(|n| n as u32),
                output_tokens: v["usage"]["output_tokens"].as_u64().map(|n| n as u32),
                total_tokens: None,
            }),
        );
        let stop = v["stop_reason"].as_str().unwrap_or("end_turn").to_string();
        let content = v["content"].as_array().cloned().unwrap_or_default();
        let (text, calls) = anthropic_extract(&content);
        if calls.is_empty() {
            if !text.is_empty() {
                on_delta(&text);
            }
            return Ok((text, total_usage, stop));
        }
        // assistant の content (tool_use 含む) をそのまま会話へ。
        convo.push(json!({ "role": "assistant", "content": content }));
        let mut results = Vec::new();
        for call in &calls {
            let (outcome, is_error) = run_tool_with_flag(&mut rt, call);
            results.push(json!({
                "type": "tool_result",
                "tool_use_id": call.id,
                "content": outcome,
                "is_error": is_error
            }));
        }
        convo.push(json!({ "role": "user", "content": results }));
    }
    Ok((BUDGET_MSG.to_string(), total_usage, "max_turns".to_string()))
}

fn anthropic_extract(content: &[Value]) -> (String, Vec<ToolCall>) {
    let mut text = String::new();
    let mut calls = Vec::new();
    for b in content {
        match b["type"].as_str() {
            Some("text") => {
                if let Some(t) = b["text"].as_str() {
                    text.push_str(t);
                }
            }
            Some("tool_use") => {
                if let (Some(id), Some(name)) = (b["id"].as_str(), b["name"].as_str()) {
                    calls.push(ToolCall {
                        id: id.to_string(),
                        name: name.to_string(),
                        args: b["input"].clone(),
                    });
                }
            }
            _ => {}
        }
    }
    (text, calls)
}

// ---------- Gemini ----------

pub(super) async fn call_gemini_tools(
    provider: &ProviderPreset,
    key: &str,
    agent: &ApiAgentConfig,
    system_prompt: &str,
    messages: &[ApiAgentMessage],
    mut rt: ToolRuntime<'_>,
    on_delta: &mut (dyn FnMut(&str) + Send),
) -> anyhow::Result<(String, Option<ApiAgentUsage>, String)> {
    let specs = tools::builtin_read_tools();
    let decls: Vec<Value> = specs
        .iter()
        .map(|s| json!({ "name": s.name, "description": s.description, "parameters": s.parameters }))
        .collect();
    let tools_field = json!([{ "functionDeclarations": decls }]);

    let mut contents: Vec<Value> = Vec::new();
    for m in messages {
        if m.role == "system" || m.role == "tool" {
            continue;
        }
        let role = if m.role == "assistant" { "model" } else { "user" };
        contents.push(json!({ "role": role, "parts": [{ "text": m.content }] }));
    }

    let mut total_usage = None;
    for _turn in 0..rt.max_turns {
        let mut body = json!({ "contents": contents, "tools": tools_field });
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
        let v: Value = HTTP_CLIENT
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
        accumulate_usage(&mut total_usage, gemini_usage(&v));
        let stop = v["candidates"][0]["finishReason"]
            .as_str()
            .unwrap_or("STOP")
            .to_string();
        let parts = v["candidates"][0]["content"]["parts"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let (text, calls) = gemini_extract(&parts);
        if calls.is_empty() {
            if !text.is_empty() {
                on_delta(&text);
            }
            return Ok((text, total_usage, stop));
        }
        // model の parts (functionCall 含む) をそのまま会話へ。
        contents.push(json!({ "role": "model", "parts": parts }));
        let mut resp_parts = Vec::new();
        for call in &calls {
            let outcome = run_tool(&mut rt, call);
            resp_parts.push(json!({
                "functionResponse": { "name": call.name, "response": { "result": outcome } }
            }));
        }
        contents.push(json!({ "role": "user", "parts": resp_parts }));
    }
    Ok((BUDGET_MSG.to_string(), total_usage, "max_turns".to_string()))
}

fn gemini_extract(parts: &[Value]) -> (String, Vec<ToolCall>) {
    let mut text = String::new();
    let mut calls = Vec::new();
    for p in parts {
        if let Some(t) = p["text"].as_str() {
            text.push_str(t);
        }
        if p["functionCall"].is_object() {
            if let Some(name) = p["functionCall"]["name"].as_str() {
                calls.push(ToolCall {
                    id: String::new(),
                    name: name.to_string(),
                    args: p["functionCall"]["args"].clone(),
                });
            }
        }
    }
    (text, calls)
}

fn gemini_usage(v: &Value) -> Option<ApiAgentUsage> {
    let u = &v["usageMetadata"];
    if !u.is_object() {
        return None;
    }
    Some(ApiAgentUsage {
        input_tokens: u["promptTokenCount"].as_u64().map(|n| n as u32),
        output_tokens: u["candidatesTokenCount"].as_u64().map(|n| n as u32),
        total_tokens: u["totalTokenCount"].as_u64().map(|n| n as u32),
    })
}

// ---------- shared ----------

/// tool を実行し、status イベントを emit して結果本文を返す。
fn run_tool(rt: &mut ToolRuntime<'_>, call: &ToolCall) -> String {
    run_tool_with_flag(rt, call).0
}

fn run_tool_with_flag(rt: &mut ToolRuntime<'_>, call: &ToolCall) -> (String, bool) {
    (rt.on_tool)(&call.name, "started", Some(&summarize_args(&call.args)));
    let outcome = tools::execute_tool(rt.project_root, &call.name, &call.args);
    (rt.on_tool)(
        &call.name,
        if outcome.is_error { "failed" } else { "completed" },
        None,
    );
    (outcome.content, outcome.is_error)
}

fn summarize_args(args: &Value) -> String {
    let s = args.to_string();
    if s.chars().count() > 120 {
        s.chars().take(120).collect::<String>() + "…"
    } else {
        s
    }
}

fn accumulate_usage(total: &mut Option<ApiAgentUsage>, add: Option<ApiAgentUsage>) {
    let Some(add) = add else {
        return;
    };
    let t = total.get_or_insert_with(ApiAgentUsage::default);
    t.input_tokens = sum_opt(t.input_tokens, add.input_tokens);
    t.output_tokens = sum_opt(t.output_tokens, add.output_tokens);
    t.total_tokens = sum_opt(t.total_tokens, add.total_tokens);
}

fn sum_opt(a: Option<u32>, b: Option<u32>) -> Option<u32> {
    match (a, b) {
        (None, None) => None,
        _ => Some(a.unwrap_or(0) + b.unwrap_or(0)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_extract_parses_tool_calls() {
        let msg = json!({
            "content": null,
            "tool_calls": [
                { "id": "call_1", "function": { "name": "read_file", "arguments": "{\"path\":\"a.txt\"}" } }
            ]
        });
        let (text, calls) = openai_extract(&msg);
        assert_eq!(text, "");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "call_1");
        assert_eq!(calls[0].name, "read_file");
        assert_eq!(calls[0].args["path"], json!("a.txt"));
    }

    #[test]
    fn openai_extract_final_text_has_no_calls() {
        let msg = json!({ "content": "here is the answer" });
        let (text, calls) = openai_extract(&msg);
        assert_eq!(text, "here is the answer");
        assert!(calls.is_empty());
    }

    #[test]
    fn anthropic_extract_separates_text_and_tool_use() {
        let content = vec![
            json!({ "type": "text", "text": "let me check " }),
            json!({ "type": "tool_use", "id": "tu_1", "name": "list_dir", "input": { "path": "." } }),
        ];
        let (text, calls) = anthropic_extract(&content);
        assert_eq!(text, "let me check ");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "list_dir");
        assert_eq!(calls[0].id, "tu_1");
        assert_eq!(calls[0].args["path"], json!("."));
    }

    #[test]
    fn gemini_extract_reads_function_call() {
        let parts = vec![
            json!({ "text": "checking" }),
            json!({ "functionCall": { "name": "read_file", "args": { "path": "x.rs" } } }),
        ];
        let (text, calls) = gemini_extract(&parts);
        assert_eq!(text, "checking");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "read_file");
        assert_eq!(calls[0].args["path"], json!("x.rs"));
        assert!(calls[0].id.is_empty());
    }

    #[test]
    fn accumulate_usage_sums_across_turns() {
        let mut total = None;
        accumulate_usage(
            &mut total,
            Some(ApiAgentUsage {
                input_tokens: Some(10),
                output_tokens: Some(5),
                total_tokens: None,
            }),
        );
        accumulate_usage(
            &mut total,
            Some(ApiAgentUsage {
                input_tokens: Some(7),
                output_tokens: Some(3),
                total_tokens: Some(20),
            }),
        );
        let u = total.unwrap();
        assert_eq!(u.input_tokens, Some(17));
        assert_eq!(u.output_tokens, Some(8));
        assert_eq!(u.total_tokens, Some(20));
    }

    #[test]
    fn summarize_args_truncates_long_payloads() {
        let big = json!({ "path": "a".repeat(300) });
        let s = summarize_args(&big);
        assert!(s.chars().count() <= 121);
        assert!(s.ends_with('…'));
    }
}

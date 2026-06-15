// providers/agentic — 非ストリーミングの tool-calling ループ (Issue #1002)。
//
// tools_enabled (supports_tools && toolMode != readOnly) のとき呼ばれる。tool 解決ターンは
// SSE の差分蓄積を避けるため非ストリーミング (完全 JSON から tool_calls をパース) で回し、
// read/write/shell/search ツールを実行して結果を会話へ戻す。最終回答は on_delta で emit する。
//
// 各 provider のツール表現:
//   - OpenAI:    request.tools[].function / response.message.tool_calls[] / role:"tool"
//   - Anthropic: request.tools[] (input_schema) / content[type=tool_use] / content[type=tool_result]
//   - Gemini:    tools[].functionDeclarations / parts[].functionCall / parts[].functionResponse

use serde_json::{json, Value};

use super::super::tools;
use super::super::tools_exec;
use super::super::tools_search;
use super::super::tools_web;
use super::super::tools_write;
use super::super::types::{ApiAgentConfig, ApiAgentMessage, ApiAgentUsage};
use super::{usage_from_value, ProviderPreset, TeamToolCtx, ToolRuntime, HTTP_CLIENT};

/// 1 件の tool 呼び出し (provider 非依存に正規化したもの)。
struct ToolCall {
    /// OpenAI/Anthropic は id を持つ。Gemini は名前で対応づけるので空。
    id: String,
    name: String,
    args: Value,
}

const BUDGET_MSG: &str = "Tool turn budget exceeded before a final answer.";

/// このターンでモデルに公開するツール spec。team 参加時は team_read / team_send / team_info を
/// 標準ツールに追加する。
fn tool_specs(rt: &ToolRuntime<'_>) -> Vec<tools::ToolSpec> {
    let mut specs = tools::builtin_read_tools();
    // Issue #1031: agentic 経路は auto (= !readOnly && supports_tools) のときだけ到達するため、
    // workspace-write な write_file / edit_file を無条件で公開する。
    specs.extend(tools_write::builtin_write_tools());
    // Issue #1034: bash (shell) も auto のとき公開する。
    specs.extend(tools_exec::builtin_exec_tools());
    // Issue #1036: grep / glob 検索 tool も auto のとき公開する。
    specs.extend(tools_search::builtin_search_tools());
    // Issue #1053: web_fetch (SSRF ガード付き) も auto のとき公開する。
    specs.extend(tools_web::builtin_web_tools());
    if rt.team.is_some() {
        specs.extend(tools::builtin_team_tools());
    }
    specs
}

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
    let specs = tool_specs(&rt);
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
            let outcome = run_tool(&mut rt, call).await;
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
    let specs = tool_specs(&rt);
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
            let (outcome, is_error) = run_tool_with_flag(&mut rt, call).await;
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
    let specs = tool_specs(&rt);
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
            let outcome = run_tool(&mut rt, call).await;
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
async fn run_tool(rt: &mut ToolRuntime<'_>, call: &ToolCall) -> String {
    run_tool_with_flag(rt, call).await.0
}

async fn run_tool_with_flag(rt: &mut ToolRuntime<'_>, call: &ToolCall) -> (String, bool) {
    (rt.on_tool)(&call.name, "started", Some(&summarize_args(&call.args)));
    let outcome = if tools::is_team_tool(&call.name) {
        // team 系 tool は team_hub の既存関数へ委譲 (async)。team 未参加なら明示エラー。
        match rt.team.as_ref() {
            Some(team) => execute_team_tool(team, &call.name, &call.args).await,
            None => tools::ToolOutcome {
                content: format!("team tool '{}' is unavailable: not part of a team", call.name),
                is_error: true,
            },
        }
    } else if tools_exec::is_exec_tool(&call.name) {
        // bash は子プロセス + timeout のため async で実行する (Issue #1034)。
        tools_exec::execute_exec_tool(rt.project_root, &call.name, &call.args).await
    } else if tools_web::is_web_tool(&call.name) {
        // web_fetch は HTTP のため async で実行する (Issue #1053)。
        tools_web::execute_web_tool(&call.name, &call.args).await
    } else {
        // read_file / list_dir / write_file / edit_file は同期ブロッキング fs を含むため
        // spawn_blocking へ退避する。write 系 (Issue #1031) は tools_write へ dispatch する。
        let project_root = rt.project_root.to_string();
        let name = call.name.clone();
        let args = call.args.clone();
        match tokio::task::spawn_blocking(move || {
            if tools_write::is_write_tool(&name) {
                tools_write::execute_write_tool(&project_root, &name, &args)
            } else if tools_search::is_search_tool(&name) {
                tools_search::execute_search_tool(&project_root, &name, &args)
            } else {
                tools::execute_tool(&project_root, &name, &args)
            }
        })
        .await
        {
            Ok(o) => o,
            Err(e) => tools::ToolOutcome {
                content: format!("tool execution failed: {e}"),
                is_error: true,
            },
        }
    };
    (rt.on_tool)(
        &call.name,
        if outcome.is_error { "failed" } else { "completed" },
        None,
    );
    (outcome.content, outcome.is_error)
}

/// team 系 tool を team_hub の既存関数へ委譲する (Issue #1004)。dispatch/inject の中核には
/// 触れず、pull 型に必要な team_read / team_send / team_info だけを呼ぶ。
async fn execute_team_tool(team: &TeamToolCtx, name: &str, args: &Value) -> tools::ToolOutcome {
    let ctx = crate::team_hub::CallContext {
        team_id: team.team_id.clone(),
        role: team.role.clone(),
        agent_id: team.agent_id.clone(),
    };
    match crate::team_hub::protocol::tools::call_api_agent_tool(&team.hub, &ctx, name, args).await {
        Ok(v) => tools::ToolOutcome {
            content: v.to_string(),
            is_error: false,
        },
        Err(e) => tools::ToolOutcome {
            content: e,
            is_error: true,
        },
    }
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
mod tests;

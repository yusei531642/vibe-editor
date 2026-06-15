// api_agents/models — provider の利用可能モデル一覧取得 (Issue #1055)。
//
// OpenAI 互換 `{base}/models` を叩く。ローカル (ollama/lmstudio) はモデルが環境依存なので
// CustomAgentEditor の候補表示に使う。レスポンスは OpenAI ({data:[{id}]}) と
// Gemini/Ollama ({models:[{name}]}) の両形を吸収する。

use crate::commands::error::{CommandError, CommandResult};
use serde_json::Value;
use std::time::Duration;

use super::providers::{provider_preset, HTTP_CLIENT};

const LIST_TIMEOUT_SECS: u64 = 15;
const MAX_MODELS: usize = 500;

#[tauri::command]
pub async fn api_agent_list_models(
    provider_id: String,
    custom_base_url: Option<String>,
) -> CommandResult<Vec<String>> {
    let preset = provider_preset(&provider_id, custom_base_url.as_deref())?;
    // 鍵があれば付ける (ローカルは無くてよい)。requires_key で鍵未登録なら provider 側が 401。
    let key = super::read_key(&provider_id).await.unwrap_or_default();

    let url = format!("{}/models", preset.base_url);
    let mut req = HTTP_CLIENT
        .get(&url)
        .timeout(Duration::from_secs(LIST_TIMEOUT_SECS));
    req = match preset.adapter {
        "gemini" => req.header("x-goog-api-key", &key),
        "anthropic" => req
            .header("x-api-key", &key)
            .header("anthropic-version", "2023-06-01"),
        _ if key.is_empty() => req,
        _ => req.bearer_auth(&key),
    };
    let resp = req
        .send()
        .await
        .map_err(|e| CommandError::internal(format!("models request failed: {e}")))?
        .error_for_status()
        .map_err(|e| CommandError::internal(format!("models request failed: {e}")))?;
    let v: Value = resp
        .json()
        .await
        .map_err(|e| CommandError::internal(format!("models parse failed: {e}")))?;

    let mut ids = parse_model_ids(&v);
    ids.sort();
    ids.dedup();
    ids.truncate(MAX_MODELS);
    Ok(ids)
}

/// OpenAI ({data:[{id}]}) / Gemini・Ollama ({models:[{name|id}]}) 形からモデル id を抽出。
fn parse_model_ids(v: &Value) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(arr) = v["data"].as_array() {
        for m in arr {
            if let Some(id) = m["id"].as_str() {
                out.push(id.to_string());
            }
        }
    }
    if out.is_empty() {
        if let Some(arr) = v["models"].as_array() {
            for m in arr {
                // gemini: name="models/gemini-..."、ollama native: name="llama3.1"
                if let Some(id) = m["id"].as_str().or_else(|| m["name"].as_str()) {
                    out.push(id.trim_start_matches("models/").to_string());
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_openai_data_shape() {
        let v = json!({ "data": [{ "id": "gpt-4o" }, { "id": "gpt-4.1" }] });
        assert_eq!(parse_model_ids(&v), vec!["gpt-4o", "gpt-4.1"]);
    }

    #[test]
    fn parses_models_array_shape_and_strips_prefix() {
        let v = json!({ "models": [{ "name": "models/gemini-2.5-pro" }, { "name": "llama3.1" }] });
        assert_eq!(parse_model_ids(&v), vec!["gemini-2.5-pro", "llama3.1"]);
    }

    #[test]
    fn empty_on_unknown_shape() {
        assert!(parse_model_ids(&json!({ "foo": 1 })).is_empty());
    }
}

use crate::pty::session::TerminalWarning;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCreateOptions {
    /// rendererがpre-subscribe用に生成する安全なterminal id。
    #[serde(default)]
    pub id: Option<String>,
    pub cwd: String,
    #[serde(default)]
    pub fallback_cwd: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Option<Vec<String>>,
    pub cols: u32,
    pub rows: u32,
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
    #[serde(default)]
    pub team_id: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub session_key: Option<String>,
    /// 同じsession / agentの生存PTYがあればspawnせず再利用する。
    #[serde(default)]
    pub attach_if_exists: bool,
    /// attach候補が無ければspawnせずattach_missを返す。
    #[serde(default)]
    pub attach_only: bool,
    #[serde(default)]
    pub claude_instructions: Option<String>,
    #[serde(default)]
    pub codex_instructions: Option<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCreateResult {
    pub ok: bool,
    pub id: Option<String>,
    pub error: Option<String>,
    pub command: Option<String>,
    pub warning: Option<TerminalWarning>,
    pub attached: Option<bool>,
    /// attach_only要求がmissし、新規spawnを行わなかった場合true。
    pub attach_miss: Option<bool>,
    pub replay: Option<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SavePastedImageResult {
    pub ok: bool,
    pub path: Option<String>,
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attach_only_is_optional_and_uses_camel_case() {
        let legacy: TerminalCreateOptions = serde_json::from_value(serde_json::json!({
            "cwd": ".", "cols": 80, "rows": 24
        }))
        .unwrap();
        assert!(!legacy.attach_only);

        let preflight: TerminalCreateOptions = serde_json::from_value(serde_json::json!({
            "cwd": ".", "cols": 80, "rows": 24, "attachOnly": true
        }))
        .unwrap();
        assert!(preflight.attach_only);
    }
}

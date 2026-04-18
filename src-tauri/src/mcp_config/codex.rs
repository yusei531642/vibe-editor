// Codex MCP 設定 (~/.codex/config.toml) の `[mcp_servers.vibe-team]` を更新

use crate::atomic_write::write_atomic;
use anyhow::Result;
use std::path::PathBuf;
use tokio::fs;

/// Issue #44: TOML basic string として埋め込む際の escape。
/// 仕様: `"`, `\`, および U+0000..U+001F の制御文字を `\uXXXX` / 既定の escape に変換する。
fn toml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{0008}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{000C}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            c if (c as u32) < 0x20 || c == '\u{7f}' => {
                out.push_str(&format!("\\u{:04X}", c as u32));
            }
            c => out.push(c),
        }
    }
    out
}

const SECTION: &str = "mcp_servers.vibe-team";
const LEGACY_SECTION: &str = "mcp_servers.vive-team";

fn config_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".codex")
        .join("config.toml")
}

/// 旧 removeTomlSection と完全互換 — `[section]` および `[section.*]` を削除。
pub fn remove_toml_section(content: &str, section: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    let mut skip = false;
    for line in content.split('\n') {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            let name = trimmed[1..trimmed.len() - 1].trim();
            skip = name == section || name.starts_with(&format!("{section}."));
        }
        if !skip {
            out.push(line);
        }
    }
    while out.last().map(|s| s.trim().is_empty()).unwrap_or(false) {
        out.pop();
    }
    out.join("\n")
}

pub async fn setup(bridge_path: &str) -> Result<()> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let mut content = match fs::read_to_string(&path).await {
        Ok(s) => s,
        Err(_) => String::new(),
    };
    content = remove_toml_section(&content, SECTION);
    content = remove_toml_section(&content, LEGACY_SECTION);
    // Issue #44: TOML basic string として正しく escape する (\\ → /, " や制御文字も含む)。
    let normalized = bridge_path.replace('\\', "/");
    let escaped = toml_escape(&normalized);
    let section = format!(
        "\n[{SECTION}]\ncommand = \"node\"\nargs = [\"{escaped}\"]\nenv_vars = [\"VIBE_TEAM_ID\", \"VIBE_TEAM_ROLE\", \"VIBE_AGENT_ID\", \"VIBE_TEAM_SOCKET\", \"VIBE_TEAM_TOKEN\"]\n",
    );
    let final_content = content + &section;
    write_atomic(&path, final_content.as_bytes()).await?;
    Ok(())
}

pub async fn cleanup() -> Result<()> {
    let path = config_path();
    let content = match fs::read_to_string(&path).await {
        Ok(s) => s,
        Err(_) => return Ok(()),
    };
    let stripped = remove_toml_section(&content, SECTION);
    let stripped = remove_toml_section(&stripped, LEGACY_SECTION);
    let cleaned = format!("{}\n", stripped.trim_end());
    write_atomic(&path, cleaned.as_bytes()).await?;
    Ok(())
}

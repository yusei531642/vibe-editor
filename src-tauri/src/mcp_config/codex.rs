// Codex MCP 設定 (~/.codex/config.toml) の `[mcp_servers.vive-team]` を更新

use anyhow::Result;
use std::path::PathBuf;
use tokio::fs;

const SECTION: &str = "mcp_servers.vive-team";

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
    let escaped = bridge_path.replace('\\', "/");
    let section = format!(
        "\n[{SECTION}]\ncommand = \"node\"\nargs = [\"{escaped}\"]\nenv_vars = [\"VIVE_TEAM_ID\", \"VIVE_TEAM_ROLE\", \"VIVE_AGENT_ID\", \"VIVE_TEAM_SOCKET\", \"VIVE_TEAM_TOKEN\"]\n",
    );
    fs::write(&path, content + &section).await?;
    Ok(())
}

pub async fn cleanup() -> Result<()> {
    let path = config_path();
    let content = match fs::read_to_string(&path).await {
        Ok(s) => s,
        Err(_) => return Ok(()),
    };
    let stripped = remove_toml_section(&content, SECTION);
    let cleaned = format!("{}\n", stripped.trim_end());
    fs::write(&path, cleaned).await?;
    Ok(())
}

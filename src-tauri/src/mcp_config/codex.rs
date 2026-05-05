// Codex MCP 設定 (~/.codex/config.toml) の `[mcp_servers.vibe-team]` を更新

use anyhow::Result;
use std::path::PathBuf;
use tokio::fs;

const SECTION: &str = "mcp_servers.vibe-team";
const LEGACY_SECTION: &str = "mcp_servers.vive-team";

/// Issue #44: TOML basic string の正式な escape。
/// `"`, `\`, 制御文字 (U+0000..U+001F / U+007F) をバックスラッシュシーケンスに変換する。
/// これをやらないと、bridge_path に `"` が含まれた瞬間に config.toml が壊れる。
fn toml_escape_basic_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\u{0008}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{000C}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            c if (c as u32) < 0x20 || c as u32 == 0x7f => {
                out.push_str(&format!("\\u{:04X}", c as u32));
            }
            c => out.push(c),
        }
    }
    out
}

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
    let mut content: String = fs::read_to_string(&path).await.unwrap_or_default();
    content = remove_toml_section(&content, SECTION);
    content = remove_toml_section(&content, LEGACY_SECTION);
    // Issue #44: bridge_path を TOML basic string 用に正規 escape。
    // まず Windows の `\` → `/` に変えて (node 側に渡すときの可搬性優先)、その上で
    // 万が一 `"` 等を含むパスが来ても構文を壊さないように basic escape を通す。
    let normalized = bridge_path.replace('\\', "/");
    let escaped = toml_escape_basic_string(&normalized);
    let section = format!(
        "\n[{SECTION}]\ncommand = \"node\"\nargs = [\"{escaped}\"]\nenv_vars = [\"VIBE_TEAM_ID\", \"VIBE_TEAM_ROLE\", \"VIBE_AGENT_ID\", \"VIBE_TEAM_SOCKET\", \"VIBE_TEAM_TOKEN\"]\n",
    );
    // Issue #37: ~/.codex/config.toml も他アプリと共有なので atomic に上書き
    let data = (content + &section).into_bytes();
    crate::commands::atomic_write::atomic_write(&path, &data).await?;
    Ok(())
}

pub async fn cleanup() -> Result<()> {
    let path = config_path();
    let Ok(content) = fs::read_to_string(&path).await else {
        return Ok(());
    };
    let stripped = remove_toml_section(&content, SECTION);
    let stripped = remove_toml_section(&stripped, LEGACY_SECTION);
    let cleaned = format!("{}\n", stripped.trim_end());
    crate::commands::atomic_write::atomic_write(&path, cleaned.as_bytes()).await?;
    Ok(())
}

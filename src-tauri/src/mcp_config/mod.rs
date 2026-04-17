// MCP 設定操作モジュール
//
// 旧 src/main/lib/mcp-config/{claude,codex,index}.ts の Rust 移植版。
// Claude Code (~/.claude.json) / Codex (~/.codex/config.toml) の
// `vive-team` MCP サーバーエントリを差分マージする。

pub mod claude;
pub mod codex;

use serde_json::{json, Value};

/// Claude/Codex MCP 設定で共有する bridge エントリ
pub fn bridge_desired(socket: &str, token: &str, bridge_path: &str) -> Value {
    let normalized = bridge_path.replace('\\', "/");
    json!({
        "type": "stdio",
        "command": "node",
        "args": [normalized],
        "env": {
            "VIVE_TEAM_SOCKET": socket,
            "VIVE_TEAM_TOKEN": token,
        }
    })
}

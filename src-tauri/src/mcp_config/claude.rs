// Claude Code MCP 設定 (~/.claude.json) の `mcpServers.vibe-team` を更新

use crate::atomic_write::write_atomic;
use anyhow::Result;
use serde_json::Value;
use std::path::PathBuf;
use tokio::fs;

const ENTRY: &str = "vibe-team";
const LEGACY_ENTRY: &str = "vive-team";

fn config_path() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".claude.json")
}

/// `mcpServers["vibe-team"]` を `desired` で上書き。
/// 既に同じ内容なら false (no-op)、変更したら true を返す。
/// 旧 `vive-team` エントリがあれば同時に削除する (名前変更による自動マイグレーション)。
pub async fn setup(desired: &Value) -> Result<bool> {
    let path = config_path();
    let mut config: Value = match fs::read(&path).await {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or(Value::Object(Default::default())),
        Err(_) => Value::Object(Default::default()),
    };
    let obj = config
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("~/.claude.json must be an object"))?;
    let servers = obj
        .entry("mcpServers")
        .or_insert(Value::Object(Default::default()));
    let servers_obj = servers
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("mcpServers must be an object"))?;

    let legacy_removed = servers_obj.remove(LEGACY_ENTRY).is_some();
    let same = servers_obj.get(ENTRY) == Some(desired);
    if same && !legacy_removed {
        return Ok(false);
    }
    servers_obj.insert(ENTRY.into(), desired.clone());
    let json = serde_json::to_vec_pretty(&config)?;
    // Issue #37: 他アプリの MCP 設定も含むファイルなので、アトミック置換で壊さない。
    write_atomic(&path, &json).await?;
    Ok(true)
}

pub async fn cleanup() -> Result<bool> {
    let path = config_path();
    let bytes = match fs::read(&path).await {
        Ok(b) => b,
        Err(_) => return Ok(false),
    };
    let mut config: Value = serde_json::from_slice(&bytes).unwrap_or_default();
    let removed = config
        .get_mut("mcpServers")
        .and_then(|s| s.as_object_mut())
        .map(|s| {
            let a = s.remove(ENTRY).is_some();
            let b = s.remove(LEGACY_ENTRY).is_some();
            a || b
        })
        .unwrap_or(false);
    if removed {
        let json = serde_json::to_vec_pretty(&config)?;
        write_atomic(&path, &json).await?;
    }
    Ok(removed)
}

// Claude Code MCP 設定 (~/.claude.json) の `mcpServers.vibe-team` を更新

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
    // Issue #37: ~/.claude.json は他アプリとも共有。半端書き込みで全消失するのを避けるため atomic に。
    crate::commands::atomic_write::atomic_write(&path, &json).await?;
    Ok(true)
}

/// Issue #118: setup/cleanup の rollback 用に、現状のファイル内容を丸ごとスナップショット。
/// `Ok(None)` はファイル未存在 (= 元々何も無い)。restore() で None を渡すとファイル削除で原状回復する。
pub async fn snapshot() -> Result<Option<Vec<u8>>> {
    let path = config_path();
    match fs::read(&path).await {
        Ok(b) => Ok(Some(b)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Issue #118: snapshot() で取った状態へ atomic に書き戻す。
pub async fn restore(snap: Option<Vec<u8>>) -> Result<()> {
    let path = config_path();
    match snap {
        Some(bytes) => {
            crate::commands::atomic_write::atomic_write(&path, &bytes).await?;
        }
        None => {
            // 元々ファイルが無かった場合は削除して原状回復
            let _ = fs::remove_file(&path).await;
        }
    }
    Ok(())
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
        // Issue #108: setup と同じく cleanup も atomic_write を使う。
        // 直接 fs::write で上書きすると、書き込み中のクラッシュで `~/.claude.json` が
        // 空 / 半端な状態で残り、Claude Code 全体の設定が失われる事故になる。
        crate::commands::atomic_write::atomic_write(&path, &json).await?;
    }
    Ok(removed)
}

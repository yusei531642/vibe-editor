// Claude Code MCP 設定 (~/.claude.json) の `mcpServers.vibe-team` を更新

use anyhow::Result;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tokio::fs;

const ENTRY: &str = "vibe-team";
const LEGACY_ENTRY: &str = "vive-team";

pub(crate) fn config_path() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".claude.json")
}

/// `mcpServers["vibe-team"]` を `desired` で上書き。
/// 既に同じ内容なら false (no-op)、変更したら true を返す。
/// 旧 `vive-team` エントリがあれば同時に削除する (名前変更による自動マイグレーション)。
///
/// Issue #597: テスト容易化のため path を引数に取る (production code は config_path() を渡す)。
pub(crate) async fn setup_at(path: &Path, desired: &Value) -> Result<bool> {
    let mut config: Value = match fs::read(path).await {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).unwrap_or_else(|_| Value::Object(Default::default()))
        }
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
    // Issue #608 (Security): API token 等を含むため 0o600 を強制 (Unix のみ effective)。
crate::commands::atomic_write::atomic_write_with_mode(path, &json, Some(0o600)).await?;
    Ok(true)
}

/// Issue #118: setup/cleanup の rollback 用に、現状のファイル内容を丸ごとスナップショット。
/// `Ok(None)` はファイル未存在 (= 元々何も無い)。restore_at() で None を渡すとファイル削除で原状回復する。
pub(crate) async fn snapshot_at(path: &Path) -> Result<Option<Vec<u8>>> {
    match fs::read(path).await {
        Ok(b) => Ok(Some(b)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Issue #118: snapshot_at() で取った状態へ atomic に書き戻す。
pub(crate) async fn restore_at(path: &Path, snap: Option<Vec<u8>>) -> Result<()> {
    match snap {
        Some(bytes) => {
            // Issue #608 (Security): rollback 経路でも 0o600 を維持。
            crate::commands::atomic_write::atomic_write_with_mode(path, &bytes, Some(0o600))
                .await?;
        }
        None => {
            // 元々ファイルが無かった場合は削除して原状回復
            let _ = fs::remove_file(path).await;
        }
    }
    Ok(())
}

pub(crate) async fn cleanup_at(path: &Path) -> Result<bool> {
    let Ok(bytes) = fs::read(path).await else {
        return Ok(false);
    };
    let mut config: Value = serde_json::from_slice(&bytes).unwrap_or_default();
    let removed = config
        .get_mut("mcpServers")
        .and_then(|s| s.as_object_mut())
        .is_some_and(|s| {
            let a = s.remove(ENTRY).is_some();
            let b = s.remove(LEGACY_ENTRY).is_some();
            a || b
        });
    if removed {
        let json = serde_json::to_vec_pretty(&config)?;
        // Issue #108: setup と同じく cleanup も atomic_write を使う。
        // 直接 fs::write で上書きすると、書き込み中のクラッシュで `~/.claude.json` が
        // 空 / 半端な状態で残り、Claude Code 全体の設定が失われる事故になる。
        // Issue #608 (Security): API token 等を含むため 0o600 を強制 (Unix のみ effective)。
crate::commands::atomic_write::atomic_write_with_mode(path, &json, Some(0o600)).await?;
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    #[tokio::test]
    async fn snapshot_returns_none_when_file_absent() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join(".claude.json");
        assert!(snapshot_at(&path).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn restore_round_trips_existing_content() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join(".claude.json");
        let original = br#"{"existing":true}"#.to_vec();
        fs::write(&path, &original).await.unwrap();

        let snap = snapshot_at(&path).await.unwrap();
        // 何か壊して restore で元に戻す
        fs::write(&path, b"corrupted").await.unwrap();
        restore_at(&path, snap).await.unwrap();
        let got = fs::read(&path).await.unwrap();
        assert_eq!(got, original);
    }

    #[tokio::test]
    async fn setup_at_returns_err_when_root_is_array() {
        // 「~/.claude.json must be an object」エラー経路 (rollback テストで使う)
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join(".claude.json");
        fs::write(&path, b"[]").await.unwrap();
        let desired = json!({ "type": "stdio" });
        let res = setup_at(&path, &desired).await;
        assert!(res.is_err(), "array root should fail with object check");
        // ファイルは触られていないはず
        let still = fs::read(&path).await.unwrap();
        assert_eq!(still, b"[]");
    }
}

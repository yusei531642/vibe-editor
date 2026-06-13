// Claude Code MCP 設定 (~/.claude.json) の `mcpServers.vibe-team` を更新

use anyhow::{Context, Result};
use serde_json::{json, Value};
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
        Ok(bytes) if bytes.is_empty() => Value::Object(Default::default()),
        Ok(bytes) => serde_json::from_slice(&bytes).with_context(|| {
            format!(
                "{} contains invalid JSON; refusing to overwrite",
                path.display()
            )
        })?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Value::Object(Default::default()),
        Err(e) => {
            return Err(e).with_context(|| {
                format!("failed to read {}; refusing to overwrite", path.display())
            });
        }
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

fn project_settings_local_path(project_root: &str) -> Option<PathBuf> {
    let root = project_root.trim();
    if root.is_empty() {
        return None;
    }
    Some(Path::new(root).join(".claude").join("settings.local.json"))
}

fn is_vibe_inbox_hook(hook: &Value) -> bool {
    hook.get("type").and_then(Value::as_str) == Some("command")
        && hook.get("command").and_then(Value::as_str) == Some("node")
        && hook
            .get("args")
            .and_then(Value::as_array)
            .is_some_and(|args| {
                args.iter().any(|v| {
                    v.as_str()
                        .is_some_and(|s| s.ends_with(crate::team_hub::inbox_watch::FILE_NAME))
                }) && args.iter().any(|v| v.as_str() == Some("--session-start"))
            })
}

fn remove_vibe_inbox_session_start(config: &mut Value) -> bool {
    let Some(groups) = config
        .get_mut("hooks")
        .and_then(|v| v.get_mut("SessionStart"))
        .and_then(Value::as_array_mut)
    else {
        return false;
    };
    let mut removed = false;
    groups.retain_mut(|group| {
        let Some(hooks) = group.get_mut("hooks").and_then(Value::as_array_mut) else {
            return true;
        };
        let before = hooks.len();
        hooks.retain(|hook| !is_vibe_inbox_hook(hook));
        removed |= hooks.len() != before;
        !hooks.is_empty()
    });
    removed
}

pub(crate) async fn setup_project_inbox_hook(
    project_root: &str,
    watcher_path: &Path,
) -> Result<bool> {
    if !crate::team_hub::delivery_mode::DeliveryMode::from_env().should_install_monitor_hook() {
        return Ok(false);
    }
    let Some(path) = project_settings_local_path(project_root) else {
        return Ok(false);
    };
    let mut config: Value = match fs::read(&path).await {
        Ok(bytes) if bytes.is_empty() => Value::Object(Default::default()),
        Ok(bytes) => serde_json::from_slice(&bytes).with_context(|| {
            format!(
                "{} contains invalid JSON; refusing to overwrite",
                path.display()
            )
        })?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Value::Object(Default::default()),
        Err(e) => return Err(e).with_context(|| format!("failed to read {}", path.display())),
    };
    if !config.is_object() {
        return Err(anyhow::anyhow!("{} must be a JSON object", path.display()));
    }
    let before = config.clone();
    remove_vibe_inbox_session_start(&mut config);
    let root = config.as_object_mut().expect("object checked above");
    let hooks = root
        .entry("hooks")
        .or_insert_with(|| Value::Object(Default::default()));
    let hooks_obj = hooks
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("hooks must be an object"))?;
    let session_start = hooks_obj
        .entry("SessionStart")
        .or_insert_with(|| Value::Array(Vec::new()));
    let groups = session_start
        .as_array_mut()
        .ok_or_else(|| anyhow::anyhow!("hooks.SessionStart must be an array"))?;
    groups.push(json!({
        "matcher": "startup|resume|clear|compact",
        "hooks": [{
            "type": "command",
            "command": "node",
            "args": [watcher_path.to_string_lossy(), "--session-start"],
            "timeout": 5
        }]
    }));
    if config == before {
        return Ok(false);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let json = serde_json::to_vec_pretty(&config)?;
    crate::commands::atomic_write::atomic_write_with_mode(&path, &json, Some(0o600)).await?;
    Ok(true)
}

pub(crate) async fn cleanup_project_inbox_hook(project_root: &str) -> Result<bool> {
    let Some(path) = project_settings_local_path(project_root) else {
        return Ok(false);
    };
    let Ok(bytes) = fs::read(&path).await else {
        return Ok(false);
    };
    let mut config: Value = serde_json::from_slice(&bytes).unwrap_or_default();
    let removed = remove_vibe_inbox_session_start(&mut config);
    if removed {
        let json = serde_json::to_vec_pretty(&config)?;
        crate::commands::atomic_write::atomic_write_with_mode(&path, &json, Some(0o600)).await?;
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

    #[tokio::test]
    async fn setup_at_returns_err_when_json_parse_fails() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join(".claude.json");
        let original = br#"{"mcpServers": {"other": true,}}"#;
        fs::write(&path, original).await.unwrap();
        let desired = json!({ "type": "stdio" });

        let res = setup_at(&path, &desired).await;

        assert!(
            res.is_err(),
            "invalid JSON must not be treated as empty config"
        );
        let msg = format!("{:#}", res.unwrap_err());
        assert!(
            msg.contains("invalid JSON"),
            "error should explain parse failure: {msg}"
        );
        let still = fs::read(&path).await.unwrap();
        assert_eq!(still, original, "invalid JSON file must not be overwritten");
    }

    #[tokio::test]
    async fn setup_at_allows_absent_and_empty_files() {
        let tmp = TempDir::new().unwrap();
        let absent_path = tmp.path().join("absent.claude.json");
        let desired = json!({ "type": "stdio" });

        let changed = setup_at(&absent_path, &desired).await.unwrap();
        assert!(changed, "absent file should be created");
        let created = fs::read_to_string(&absent_path).await.unwrap();
        assert!(created.contains("vibe-team"));

        let empty_path = tmp.path().join("empty.claude.json");
        fs::write(&empty_path, b"").await.unwrap();
        let changed = setup_at(&empty_path, &desired).await.unwrap();
        assert!(changed, "empty file should be initialized");
        let initialized = fs::read_to_string(&empty_path).await.unwrap();
        assert!(initialized.contains("vibe-team"));
    }

    #[test]
    fn remove_vibe_inbox_session_start_removes_only_managed_hook() {
        let mut config = json!({
            "hooks": {
                "SessionStart": [{
                    "matcher": "startup",
                    "hooks": [
                        { "type": "command", "command": "node", "args": ["/x/team-inbox-watch.js", "--session-start"] },
                        { "type": "command", "command": "echo", "args": ["keep"] }
                    ]
                }]
            }
        });

        assert!(remove_vibe_inbox_session_start(&mut config));
        let hooks = config["hooks"]["SessionStart"][0]["hooks"]
            .as_array()
            .expect("hooks array");
        assert_eq!(hooks.len(), 1);
        assert_eq!(hooks[0]["command"].as_str(), Some("echo"));
    }
}

// terminal_tabs.* command — Issue #661
//
// IDE モード terminal タブの永続化。~/.vibe-editor/terminal-tabs.json を atomic write で
// 読み書きする。team-history.json とは独立した SSOT で、IDE 単独タブの cwd / cols / rows /
// Claude session id を再起動跨ぎで保持する。
//
// 設計原則:
//   - schemaVersion 一致しないファイルは読まずに `None` 返却 (= 旧データ無視で素の起動)
//   - byProject は raw projectRoot を key とし、検索/書込側で `normalize_project_root` 経由
//   - cache + LOCK で disk I/O 最小化 (team_history.rs と同流儀)

use crate::commands::team_history::MutationResult;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tokio::fs;
use tokio::sync::Mutex;

/// renderer 側 `TERMINAL_TABS_SCHEMA_VERSION` と一致させる
pub const TERMINAL_TABS_SCHEMA_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PersistedTerminalTab {
    pub tab_id: String,
    pub kind: String,
    pub cwd: String,
    pub cols: u32,
    pub rows: u32,
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct PersistedTerminalTabsByProject {
    pub tabs: Vec<PersistedTerminalTab>,
    pub active_tab_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PersistedTerminalTabsFile {
    pub schema_version: u32,
    pub last_saved_at: String,
    pub by_project: HashMap<String, PersistedTerminalTabsByProject>,
}

impl Default for PersistedTerminalTabsFile {
    fn default() -> Self {
        Self {
            schema_version: TERMINAL_TABS_SCHEMA_VERSION,
            last_saved_at: String::new(),
            by_project: HashMap::new(),
        }
    }
}

/// in-memory cache。`None` = 未ロード、`Some(...)` = ディスクと同期済み。
static CACHE: once_cell::sync::Lazy<Mutex<Option<PersistedTerminalTabsFile>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));

static LOCK: once_cell::sync::Lazy<Mutex<()>> = once_cell::sync::Lazy::new(|| Mutex::new(()));

fn store_path() -> PathBuf {
    crate::util::config_paths::terminal_tabs_path()
}

/// disk からロードする。schemaVersion 不一致は `None` を返して旧データを無視する。
async fn load_from_disk() -> Option<PersistedTerminalTabsFile> {
    let path = store_path();
    let bytes = fs::read(&path).await.ok()?;
    let file: PersistedTerminalTabsFile = match serde_json::from_slice(&bytes) {
        Ok(f) => f,
        Err(e) => {
            tracing::warn!(
                "[terminal_tabs] parse failed (treating as missing): {e}"
            );
            return None;
        }
    };
    if file.schema_version != TERMINAL_TABS_SCHEMA_VERSION {
        tracing::info!(
            "[terminal_tabs] schemaVersion mismatch (file={}, current={}), ignoring",
            file.schema_version,
            TERMINAL_TABS_SCHEMA_VERSION
        );
        return None;
    }
    Some(file)
}

async fn ensure_loaded(cache: &mut Option<PersistedTerminalTabsFile>) {
    if cache.is_some() {
        return;
    }
    *cache = Some(load_from_disk().await.unwrap_or_default());
}

async fn save_to_disk(file: &PersistedTerminalTabsFile) -> Result<(), String> {
    let path = store_path();
    let json = serde_json::to_vec_pretty(file).map_err(|e| e.to_string())?;
    // Issue #608: terminal-tabs.json は Claude session id (UUID) と cwd を持ち、漏洩すると
    // `~/.claude/projects/<encoded>/<uuid>.jsonl` の会話履歴に間接アクセスできるため
    // 機密ファイル扱い。`~/.claude.json` / role-profiles 等と同じく 0o600 を強制する。
    // Windows では mode は no-op (Windows ACL 強制は別 issue で対応)。
    crate::commands::atomic_write::atomic_write_with_mode(&path, &json, Some(0o600))
        .await
        .map_err(|e| e.to_string())
}

/// load: 永続化ファイルが空 / 未存在 / schemaVersion 不一致なら `None` 返却。
/// renderer 側はこれで「素の IDE モード起動」と判定して順序復元をスキップする。
#[tauri::command]
pub async fn terminal_tabs_load() -> Option<PersistedTerminalTabsFile> {
    let _g = LOCK.lock().await;
    let mut cache = CACHE.lock().await;
    ensure_loaded(&mut cache).await;
    let file = cache.as_ref().expect("ensured");
    if file.by_project.is_empty() && file.last_saved_at.is_empty() {
        return None;
    }
    Some(file.clone())
}

/// save: renderer から渡された全体を atomic 上書き。
/// renderer 側 hook が「他プロジェクト entry 保持 + 自分の entry 更新」を行う read-modify-write
/// なので、ここは渡された file をそのまま採用する (= cache 更新 + disk write)。
#[tauri::command]
pub async fn terminal_tabs_save(file: PersistedTerminalTabsFile) -> MutationResult {
    let _g = LOCK.lock().await;
    let mut cache = CACHE.lock().await;
    *cache = Some(file.clone());
    match save_to_disk(&file).await {
        Ok(()) => MutationResult {
            ok: true,
            error: None,
        },
        Err(e) => MutationResult {
            ok: false,
            error: Some(e),
        },
    }
}

/// clear: ファイル削除 + cache を空に戻す。設定からの「タブ復元を全消去」操作などで使う。
/// 既に存在しないときも `ok=true` を返す (idempotent)。
#[tauri::command]
pub async fn terminal_tabs_clear() -> MutationResult {
    let _g = LOCK.lock().await;
    let mut cache = CACHE.lock().await;
    let path = store_path();
    *cache = Some(PersistedTerminalTabsFile::default());
    match fs::remove_file(&path).await {
        Ok(()) => MutationResult {
            ok: true,
            error: None,
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => MutationResult {
            ok: true,
            error: None,
        },
        Err(e) => MutationResult {
            ok: false,
            error: Some(e.to_string()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_tab(id: &str) -> PersistedTerminalTab {
        PersistedTerminalTab {
            tab_id: id.to_string(),
            kind: "claude".to_string(),
            cwd: "/tmp/repo".to_string(),
            cols: 100,
            rows: 30,
            session_id: Some("11111111-2222-3333-4444-555555555555".to_string()),
            label: None,
            team_id: None,
            agent_id: None,
            role: None,
        }
    }

    #[test]
    fn schema_version_constant_matches_default_file() {
        let f = PersistedTerminalTabsFile::default();
        assert_eq!(f.schema_version, TERMINAL_TABS_SCHEMA_VERSION);
        assert!(f.by_project.is_empty());
    }

    #[test]
    fn round_trip_serde_preserves_fields() {
        let mut by_project = HashMap::new();
        by_project.insert(
            "C:\\repo".to_string(),
            PersistedTerminalTabsByProject {
                tabs: vec![sample_tab("1"), sample_tab("2")],
                active_tab_id: Some("1".to_string()),
            },
        );
        let file = PersistedTerminalTabsFile {
            schema_version: TERMINAL_TABS_SCHEMA_VERSION,
            last_saved_at: "2026-05-09T00:00:00Z".to_string(),
            by_project,
        };
        let json = serde_json::to_string(&file).unwrap();
        // camelCase 確認 (snake_case が漏れていないこと)
        assert!(json.contains("\"schemaVersion\""));
        assert!(json.contains("\"byProject\""));
        assert!(json.contains("\"activeTabId\""));
        assert!(json.contains("\"tabId\""));
        assert!(json.contains("\"sessionId\""));
        let restored: PersistedTerminalTabsFile = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.schema_version, TERMINAL_TABS_SCHEMA_VERSION);
        assert_eq!(restored.by_project.len(), 1);
        assert_eq!(restored.by_project["C:\\repo"].tabs.len(), 2);
        assert_eq!(
            restored.by_project["C:\\repo"].active_tab_id.as_deref(),
            Some("1")
        );
    }

    #[test]
    fn missing_optional_fields_default_to_none() {
        let json = r#"{
            "schemaVersion": 1,
            "lastSavedAt": "",
            "byProject": {
                "/tmp/r": {
                    "tabs": [{
                        "tabId": "1",
                        "kind": "claude",
                        "cwd": "/tmp/r",
                        "cols": 80,
                        "rows": 24,
                        "sessionId": null
                    }],
                    "activeTabId": null
                }
            }
        }"#;
        let file: PersistedTerminalTabsFile = serde_json::from_str(json).unwrap();
        let tab = &file.by_project["/tmp/r"].tabs[0];
        assert!(tab.label.is_none());
        assert!(tab.team_id.is_none());
        assert!(tab.agent_id.is_none());
        assert!(tab.role.is_none());
    }
}

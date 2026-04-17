// team_history.* command — 旧 src/main/ipc/team-history.ts に対応
//
// ~/.vibe-editor/team-history.json (JSON 配列) を読み書き。
// プロジェクト単位のフィルタ、最新 20 件 + lastUsedAt 降順保持。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tokio::fs;
use tokio::sync::Mutex;

const MAX_ENTRIES: usize = 20;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TeamHistoryMember {
    pub role: String,
    pub agent: String,
    pub session_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TeamCanvasNode {
    pub agent_id: String,
    pub x: f64,
    pub y: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TeamCanvasViewport {
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TeamCanvasState {
    pub nodes: Vec<TeamCanvasNode>,
    pub viewport: TeamCanvasViewport,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TeamHistoryEntry {
    pub id: String,
    pub name: String,
    pub project_root: String,
    pub created_at: String,
    pub last_used_at: String,
    pub members: Vec<TeamHistoryMember>,
    /// Phase 5: Canvas モードの配置状態 (optional, 後方互換)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canvas_state: Option<TeamCanvasState>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MutationResult {
    pub ok: bool,
    pub error: Option<String>,
}

static LOCK: once_cell::sync::Lazy<Mutex<()>> = once_cell::sync::Lazy::new(|| Mutex::new(()));

fn store_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_default();
    home.join(".vibe-editor").join("team-history.json")
}

async fn load_all() -> Vec<TeamHistoryEntry> {
    let path = store_path();
    let bytes = match fs::read(&path).await {
        Ok(b) => b,
        Err(_) => return vec![],
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

async fn save_all(entries: &[TeamHistoryEntry]) -> Result<(), String> {
    let path = store_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_vec_pretty(entries).map_err(|e| e.to_string())?;
    fs::write(&path, json).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn team_history_list(project_root: String) -> Vec<TeamHistoryEntry> {
    let _g = LOCK.lock().await;
    load_all()
        .await
        .into_iter()
        .filter(|e| e.project_root == project_root)
        .collect()
}

#[tauri::command]
pub async fn team_history_save(entry: TeamHistoryEntry) -> MutationResult {
    let _g = LOCK.lock().await;
    let mut all = load_all().await;
    all.retain(|e| e.id != entry.id);
    all.insert(0, entry);
    all.sort_by(|a, b| b.last_used_at.cmp(&a.last_used_at));
    if all.len() > MAX_ENTRIES {
        all.truncate(MAX_ENTRIES);
    }
    match save_all(&all).await {
        Ok(_) => MutationResult {
            ok: true,
            error: None,
        },
        Err(e) => MutationResult {
            ok: false,
            error: Some(e),
        },
    }
}

#[tauri::command]
pub async fn team_history_delete(id: String) -> MutationResult {
    let _g = LOCK.lock().await;
    let mut all = load_all().await;
    let before = all.len();
    all.retain(|e| e.id != id);
    if all.len() == before {
        return MutationResult {
            ok: true,
            error: None,
        };
    }
    match save_all(&all).await {
        Ok(_) => MutationResult {
            ok: true,
            error: None,
        },
        Err(e) => MutationResult {
            ok: false,
            error: Some(e),
        },
    }
}

// team_history.* command — 旧 src/main/ipc/team-history.ts に対応
//
// ~/.vibe-editor/team-history.json (JSON 配列) を読み書き。
// プロジェクト単位のフィルタ、最新 20 件 + lastUsedAt 降順保持。

use crate::atomic_write::write_atomic;
use crate::pty::path_norm::normalize_project_root;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use tokio::fs;
use tokio::sync::Mutex;

/// Issue #27: 20 件制限は project 単位で適用する。
/// ("project A で 10 件保存している状態で project B を使うと project A が消える"
/// 挙動を避けるため)
const MAX_ENTRIES_PER_PROJECT: usize = 20;

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
    let json = serde_json::to_vec_pretty(entries).map_err(|e| e.to_string())?;
    // Issue #37: temp → rename のアトミック置換。
    write_atomic(&path, &json).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn team_history_list(project_root: String) -> Vec<TeamHistoryEntry> {
    let _g = LOCK.lock().await;
    // Issue #32: 比較は normalize 後の値で行う
    let target = normalize_project_root(&project_root);
    load_all()
        .await
        .into_iter()
        .filter(|e| normalize_project_root(&e.project_root) == target)
        .collect()
}

#[tauri::command]
pub async fn team_history_save(entry: TeamHistoryEntry) -> MutationResult {
    let _g = LOCK.lock().await;
    let new_id = entry.id.clone();
    let mut all = load_all().await;
    all.retain(|e| e.id != entry.id);
    all.insert(0, entry);
    all.sort_by(|a, b| b.last_used_at.cmp(&a.last_used_at));

    // Issue #27 + #46: 20 件上限は project ごとに掛けるが、新しく追加された entry は
    // 必ず保持する (古い last_used_at で保存されても silent drop されない)。
    // project 内の件数が超えるときは、一番古い別 entry が押し出される。
    let protected: HashSet<&str> = std::iter::once(new_id.as_str()).collect();
    let mut kept: Vec<TeamHistoryEntry> = Vec::with_capacity(all.len());
    let mut per_project_count: HashMap<String, usize> = HashMap::new();
    // Pass 1: 保護対象を先に確保。
    for e in all.iter() {
        if protected.contains(e.id.as_str()) {
            let key = normalize_project_root(&e.project_root);
            *per_project_count.entry(key).or_insert(0) += 1;
        }
    }
    for e in all.into_iter() {
        if protected.contains(e.id.as_str()) {
            kept.push(e);
            continue;
        }
        let key = normalize_project_root(&e.project_root);
        let count = per_project_count.entry(key).or_insert(0);
        if *count < MAX_ENTRIES_PER_PROJECT {
            *count += 1;
            kept.push(e);
        }
    }

    match save_all(&kept).await {
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

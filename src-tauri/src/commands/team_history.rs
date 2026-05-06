// team_history.* command — 旧 src/main/ipc/team-history.ts に対応
//
// ~/.vibe-editor/team-history.json (JSON 配列) を読み書き。
// プロジェクト単位のフィルタ、最新 20 件 + lastUsedAt 降順保持。

use crate::commands::team_state::TeamOrchestrationSummary;
use crate::pty::path_norm::normalize_project_root;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tokio::fs;
use tokio::sync::Mutex;

/// Issue #132: in-memory cache。`load_all` が毎回ディスク I/O していたのを解消する。
/// `None` は「未ロード」、`Some(...)` は「ディスクと同期済み」状態。
static CACHE: once_cell::sync::Lazy<Mutex<Option<Vec<TeamHistoryEntry>>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));

/// Issue #27: 20 件制限は project 単位で適用する。
/// ("project A で 10 件保存している状態で project B を使うと project A が消える"
/// 挙動を避けるため)
const MAX_ENTRIES_PER_PROJECT: usize = 20;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TeamHistoryMember {
    pub role: String,
    pub agent: String,
    /// Issue #470: Canvas / TeamHub の配送先 identity。旧履歴では未設定のため復元時 fallback する。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    pub session_id: Option<String>,
    /// ユーザーが手動でリネームしたタブ名 (resume 時に復元する。null なら自動生成名)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_label: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
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

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TeamCanvasViewport {
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TeamCanvasState {
    pub nodes: Vec<TeamCanvasNode>,
    pub viewport: TeamCanvasViewport,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TeamOrganizationMeta {
    pub id: String,
    pub name: String,
    pub color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HandoffReference {
    pub id: String,
    pub kind: String,
    pub status: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    pub json_path: String,
    pub markdown_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replacement_for_agent_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TeamHistoryEntry {
    pub id: String,
    pub name: String,
    pub project_root: String,
    pub created_at: String,
    pub last_used_at: String,
    pub members: Vec<TeamHistoryMember>,
    /// Issue #370: Canvas 複数組織の表示・復元用メタデータ (optional, 後方互換)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organization: Option<TeamOrganizationMeta>,
    /// Phase 5: Canvas モードの配置状態 (optional, 後方互換)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canvas_state: Option<TeamCanvasState>,
    /// Issue #359: 最新 handoff の参照のみ。本文は handoffs store に置く。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_handoff: Option<HandoffReference>,
    /// Issue #470: TeamHub orchestration state の軽量要約。本体は team-state store に置く。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orchestration: Option<TeamOrchestrationSummary>,
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

/// Issue #132: cache が live なら disk I/O をスキップ。
/// 初回呼び出し時のみディスクから読む。以後 LOCK 配下で cache を直接更新する。
async fn ensure_loaded(cache: &mut Option<Vec<TeamHistoryEntry>>) {
    if cache.is_some() {
        return;
    }
    let path = store_path();
    let bytes = match fs::read(&path).await {
        Ok(b) => b,
        Err(_) => {
            *cache = Some(Vec::new());
            return;
        }
    };
    let entries = serde_json::from_slice::<Vec<TeamHistoryEntry>>(&bytes).unwrap_or_default();
    *cache = Some(entries);
}

async fn save_all(entries: &[TeamHistoryEntry]) -> Result<(), String> {
    let path = store_path();
    let json = serde_json::to_vec_pretty(entries).map_err(|e| e.to_string())?;
    // Issue #37: クラッシュ耐性のため atomic write を使う
    crate::commands::atomic_write::atomic_write(&path, &json)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn team_history_list(project_root: String) -> Vec<TeamHistoryEntry> {
    let _g = LOCK.lock().await;
    let mut cache = CACHE.lock().await;
    ensure_loaded(&mut cache).await;
    // Issue #32: 比較は normalize 後の値で行う
    let target = normalize_project_root(&project_root);
    cache
        .as_ref()
        .map(|all| {
            all.iter()
                .filter(|e| normalize_project_root(&e.project_root) == target)
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

/// Issue #132 共通ヘルパ: 1 つの新エントリを cache に merge して MAX 件まで圧縮する。
fn merge_entry(all: &mut Vec<TeamHistoryEntry>, entry: TeamHistoryEntry) {
    all.retain(|e| e.id != entry.id);
    let new_entry_key = normalize_project_root(&entry.project_root);
    all.sort_by(|a, b| b.last_used_at.cmp(&a.last_used_at));
    let mut kept: Vec<TeamHistoryEntry> = Vec::with_capacity(all.len() + 1);
    kept.push(entry);
    let mut per_project_count: HashMap<String, usize> = HashMap::new();
    per_project_count.insert(new_entry_key, 1);
    for e in std::mem::take(all).into_iter() {
        let key = normalize_project_root(&e.project_root);
        let count = per_project_count.entry(key).or_insert(0);
        if *count < MAX_ENTRIES_PER_PROJECT {
            *count += 1;
            kept.push(e);
        }
    }
    kept.sort_by(|a, b| b.last_used_at.cmp(&a.last_used_at));
    *all = kept;
}

async fn hydrate_orchestration_summary(entry: &mut TeamHistoryEntry) {
    if let Some(summary) =
        crate::commands::team_state::orchestration_summary(&entry.project_root, &entry.id).await
    {
        entry.orchestration = Some(summary);
    }
}

#[tauri::command]
pub async fn team_history_save(mut entry: TeamHistoryEntry) -> MutationResult {
    hydrate_orchestration_summary(&mut entry).await;
    let _g = LOCK.lock().await;
    let mut cache = CACHE.lock().await;
    ensure_loaded(&mut cache).await;
    let all = cache.as_mut().expect("ensured");

    // Issue #46: 新エントリは必ず残す。merge_entry で per-project MAX 件まで圧縮。
    merge_entry(all, entry);

    match save_all(all).await {
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

/// Issue #132: 複数チームの保存を 1 IPC + 1 disk write にまとめる。
/// CanvasLayout の auto-save が N チーム分 N 回保存していたのを 1 回にする。
#[tauri::command]
pub async fn team_history_save_batch(entries: Vec<TeamHistoryEntry>) -> MutationResult {
    if entries.is_empty() {
        return MutationResult {
            ok: true,
            error: None,
        };
    }
    let _g = LOCK.lock().await;
    let mut cache = CACHE.lock().await;
    ensure_loaded(&mut cache).await;
    let all = cache.as_mut().expect("ensured");
    for mut entry in entries {
        hydrate_orchestration_summary(&mut entry).await;
        merge_entry(all, entry);
    }
    match save_all(all).await {
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
    let mut cache = CACHE.lock().await;
    ensure_loaded(&mut cache).await;
    let all = cache.as_mut().expect("ensured");
    let before = all.len();
    all.retain(|e| e.id != id);
    if all.len() == before {
        return MutationResult {
            ok: true,
            error: None,
        };
    }
    match save_all(all).await {
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

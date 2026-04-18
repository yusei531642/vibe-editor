// settings.* command — 旧 src/main/ipc/settings.ts に対応
//
// userData/settings.json に AppSettings を保存。
// 既存 Electron では app.getPath('userData') を使っていたが、
// Tauri では `~/.vibe-editor/settings.json` に統一する (シンプル化)。
// Electron からの移行時は旧 settings.json を一度 import する処理が必要 (Phase 1 後半 TODO)。

use crate::commands::atomic_write::atomic_write;
use once_cell::sync::Lazy;
use serde_json::Value;
use std::path::PathBuf;
use tokio::fs;
use tokio::sync::Mutex;

fn settings_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_default();
    home.join(".vibe-editor").join("settings.json")
}

/// Issue #37: 並列 save を直列化する。atomic_write だけでは同時 2 save で
/// どちらかが temp rename 競合して 1 つが失敗しうるが、この Mutex で書き込みを 1 つずつに。
static SAVE_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

#[tauri::command]
pub async fn settings_load() -> Value {
    tracing::info!("[IPC] settings_load called");
    let path = settings_path();
    match fs::read(&path).await {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        Err(_) => Value::Null,
    }
}

#[tauri::command]
pub async fn settings_save(settings: Value) -> Result<(), String> {
    let _g = SAVE_LOCK.lock().await;
    let path = settings_path();
    let json = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
    // Issue #37: 書き込み中の crash で settings.json が半端 JSON にならないよう atomic
    atomic_write(&path, &json).await.map_err(|e| e.to_string())
}

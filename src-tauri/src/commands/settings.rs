// settings.* command — 旧 src/main/ipc/settings.ts に対応
//
// userData/settings.json に AppSettings を保存。
// 既存 Electron では app.getPath('userData') を使っていたが、
// Tauri では `~/.vibe-editor/settings.json` に統一する (シンプル化)。
// Electron からの移行時は旧 settings.json を一度 import する処理が必要 (Phase 1 後半 TODO)。

use serde_json::Value;
use std::path::PathBuf;
use tokio::fs;

fn settings_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_default();
    home.join(".vibe-editor").join("settings.json")
}

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
    let path = settings_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&path, json).await.map_err(|e| e.to_string())
}

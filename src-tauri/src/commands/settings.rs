// settings.* command — 旧 src/main/ipc/settings.ts に対応
//
// userData/settings.json に AppSettings を保存。
// 既存 Electron では app.getPath('userData') を使っていたが、
// Tauri では `~/.vibe-editor/settings.json` に統一する (シンプル化)。
// Electron からの移行時は旧 settings.json を一度 import する処理が必要 (Phase 1 後半 TODO)。

use crate::atomic_write::write_atomic;
use once_cell::sync::Lazy;
use serde_json::Value;
use std::path::PathBuf;
use tokio::fs;
use tokio::sync::Mutex;

fn settings_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_default();
    home.join(".vibe-editor").join("settings.json")
}

/// Issue #37: 保存をシリアライズして、並列書き込みでも互いに潰し合わないようにする。
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
    // Issue #37: temp → rename でアトミック置換。クラッシュ時の半端書き込みを回避。
    write_atomic(&path, &json).await.map_err(|e| e.to_string())
}

// role_profiles.* command
//
// ~/.vibe-editor/role-profiles.json (RoleProfilesFile) の load / save。
// 形式の検証は renderer 側の TS で行う想定なので、ここでは raw JSON を扱うだけ。

use crate::commands::atomic_write::atomic_write;
use once_cell::sync::Lazy;
use serde_json::Value;
use std::path::PathBuf;
use tokio::fs;
use tokio::sync::Mutex;

fn role_profiles_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_default();
    home.join(".vibe-editor").join("role-profiles.json")
}

static SAVE_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

#[tauri::command]
pub async fn role_profiles_load() -> Value {
    let path = role_profiles_path();
    match fs::read(&path).await {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        Err(_) => Value::Null,
    }
}

#[tauri::command]
pub async fn role_profiles_save(file: Value) -> Result<(), String> {
    let _g = SAVE_LOCK.lock().await;
    let path = role_profiles_path();
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir).await;
    }
    let json = serde_json::to_vec_pretty(&file).map_err(|e| e.to_string())?;
    atomic_write(&path, &json).await.map_err(|e| e.to_string())
}

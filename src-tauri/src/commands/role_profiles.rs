// role_profiles.* command
//
// ~/.vibe-editor/role-profiles.json (RoleProfilesFile) の load / save。
// 形式の検証は renderer 側の TS で行う想定なので、ここでは raw JSON を扱うだけ。

use crate::commands::atomic_write::atomic_write_with_mode;
use once_cell::sync::Lazy;
use serde_json::Value;
use tokio::fs;
use tokio::sync::Mutex;

static SAVE_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

#[tauri::command]
pub async fn role_profiles_load() -> Value {
    let path = crate::util::config_paths::role_profiles_path();
    let Ok(bytes) = fs::read(&path).await else {
        return Value::Null;
    };
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(v) => v,
        Err(e) => {
            // Issue #170: 旧実装は parse 失敗で黙って Null を返し、次の save で
            // 役割プロファイルが完全消失していた。.bak 退避してから Null を返す。
            tracing::error!(
                "[role-profiles] parse failed ({}), backing up to role-profiles.json.bak",
                e
            );
            let bak = path.with_extension("json.bak");
            // Issue #608 (Security): role profile instructions は injection-prone な
            // ユーザー定義 prompt を含むため、バックアップも 0o600 で書く。
            let _ = atomic_write_with_mode(&bak, &bytes, Some(0o600)).await;
            Value::Null
        }
    }
}

#[tauri::command]
pub async fn role_profiles_save(file: Value) -> crate::commands::error::CommandResult<()> {
    let _g = SAVE_LOCK.lock().await;
    let path = crate::util::config_paths::role_profiles_path();
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir).await;
    }
    let json = serde_json::to_vec_pretty(&file).map_err(|e| e.to_string())?;
    // Issue #608 (Security): instructions が機密扱いなので 0o600 で永続化。
    Ok(atomic_write_with_mode(&path, &json, Some(0o600))
        .await
        .map_err(|e| e.to_string())?)
}

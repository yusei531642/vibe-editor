// role_profiles.* command
//
// ~/.vibe-editor/role-profiles.json (RoleProfilesFile) の load / save。
// 形式の検証は renderer 側の TS で行う想定なので、ここでは raw JSON を扱うだけ。

use crate::commands::atomic_write::atomic_write_with_mode;
use crate::commands::safe_load::{safe_load_or_quarantine, LoadOutcome};
use once_cell::sync::Lazy;
use serde_json::Value;
use std::path::Path;
use tokio::sync::Mutex;

static SAVE_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

/// Issue #947: 読み込みは safe_load 共通基盤に統一する。
/// parse 失敗時の挙動 (default に倒す前に `.bak.<ts>` へコピー退避、0o600、5 世代回転 —
/// #170 / #644 / #608 の積み上げ) は safe_load 側に集約済みで等価。
async fn role_profiles_load_at(path: &Path) -> Value {
    match safe_load_or_quarantine::<Value>(path, Some(0o600)).await {
        LoadOutcome::Loaded(v) => v,
        LoadOutcome::Absent | LoadOutcome::Corrupted => Value::Null,
    }
}

#[tauri::command]
pub async fn role_profiles_load() -> Value {
    let path = crate::util::config_paths::role_profiles_path();
    role_profiles_load_at(&path).await
}

#[tauri::command]
pub async fn role_profiles_save(file: Value) -> crate::commands::error::CommandResult<()> {
    let _g = SAVE_LOCK.lock().await;
    let path = crate::util::config_paths::role_profiles_path();
    // Issue #838: 親ディレクトリ作成は `atomic_write_with_mode` 冒頭で行われるため、
    // ここでの明示的な create_dir_all は冗長 (settings_save も手動 create はしない)。削除した。
    let json = serde_json::to_vec_pretty(&file).map_err(|e| e.to_string())?;
    // Issue #608 (Security): instructions が機密扱いなので 0o600 で永続化。
    Ok(atomic_write_with_mode(&path, &json, Some(0o600))
        .await
        .map_err(|e| e.to_string())?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::fs;

    #[tokio::test]
    async fn load_at_returns_null_for_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("role-profiles.json");
        assert_eq!(role_profiles_load_at(&path).await, Value::Null);
    }

    #[tokio::test]
    async fn load_at_parses_valid_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("role-profiles.json");
        fs::write(&path, br#"{"profiles":[{"id":"leader"}]}"#)
            .await
            .unwrap();
        assert_eq!(
            role_profiles_load_at(&path).await,
            json!({"profiles":[{"id":"leader"}]})
        );
    }

    /// Issue #947 (元 #170/#644): 破損 JSON は Null に倒す前に `.bak.<ts>` へ退避され、
    /// 原本はコピー退避なので残置される (次回 save が上書きする)。
    #[tokio::test]
    async fn load_at_quarantines_corrupt_json_before_null() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("role-profiles.json");
        let corrupt = b"{ broken json";
        fs::write(&path, corrupt).await.unwrap();

        assert_eq!(role_profiles_load_at(&path).await, Value::Null);
        assert!(path.exists(), "copy-style backup must leave the original");

        let mut rd = fs::read_dir(dir.path()).await.unwrap();
        let mut found = false;
        while let Ok(Some(entry)) = rd.next_entry().await {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("role-profiles.json.bak.") {
                assert_eq!(fs::read(entry.path()).await.unwrap(), corrupt);
                found = true;
            }
        }
        assert!(found, "timestamped backup of the corrupt file must exist");
    }
}

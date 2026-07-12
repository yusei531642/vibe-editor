//! Issue #1193: custom mascot は native file picker の選択結果を private store へコピーし、
//! data URL で返す。settings.json の表示用 path や renderer 入力を読み出し authority として
//! 再利用しない (`settings.rs` から分離した専用経路)。

use crate::commands::atomic_write::atomic_write_with_mode;
use crate::commands::error::{CommandError, CommandResult};
use serde::{Deserialize, Serialize};
use std::path::Path;
use tokio::fs;

const CUSTOM_MASCOT_SCHEMA_VERSION: u8 = 1;
const MAX_CUSTOM_MASCOT_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredCustomMascot {
    schema_version: u8,
    mime: String,
    data_base64: String,
}

fn custom_mascot_mime(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" | "apng" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "avif" => Some("image/avif"),
        "bmp" => Some("image/bmp"),
        "ico" => Some("image/x-icon"),
        _ => None,
    }
}

/// native file picker の選択結果をprivate storeへコピーする。settingsの表示用pathや
/// renderer入力を読み出しauthorityとして再利用しない。
#[tauri::command]
pub async fn settings_pick_custom_mascot(
    app: tauri::AppHandle,
    title: Option<String>,
) -> CommandResult<Option<String>> {
    let filter = crate::commands::dialog::DialogFileFilter {
        name: "Images".to_string(),
        extensions: vec![
            "png".into(),
            "jpg".into(),
            "jpeg".into(),
            "gif".into(),
            "webp".into(),
            "avif".into(),
            "bmp".into(),
            "ico".into(),
            "apng".into(),
        ],
    };
    let Some(selected) = crate::commands::dialog::pick_file(&app, title, Some(vec![filter])).await
    else {
        return Ok(None);
    };
    let path = Path::new(&selected);
    let mime = custom_mascot_mime(path)
        .ok_or_else(|| CommandError::validation("unsupported custom mascot image type"))?;
    let metadata = fs::metadata(path)
        .await
        .map_err(|error| CommandError::Io(format!("read custom mascot metadata failed: {error}")))?;
    if !metadata.is_file() || metadata.len() > MAX_CUSTOM_MASCOT_BYTES {
        return Err(CommandError::validation(
            "custom mascot must be a regular image file no larger than 5 MiB",
        ));
    }
    let bytes = fs::read(path)
        .await
        .map_err(|error| CommandError::Io(format!("read custom mascot failed: {error}")))?;
    use base64::Engine;
    let record = StoredCustomMascot {
        schema_version: CUSTOM_MASCOT_SCHEMA_VERSION,
        mime: mime.to_string(),
        data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
    };
    let json = serde_json::to_vec(&record)?;
    atomic_write_with_mode(
        &crate::util::config_paths::custom_mascot_path(),
        &json,
        Some(0o600),
    )
    .await
    .map_err(|error| CommandError::Io(format!("store custom mascot failed: {error}")))?;
    Ok(Some(selected))
}

#[tauri::command]
pub async fn settings_load_custom_mascot() -> CommandResult<Option<String>> {
    let bytes = match fs::read(crate::util::config_paths::custom_mascot_path()).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(CommandError::Io(format!(
                "read custom mascot store failed: {error}"
            )))
        }
    };
    let record: StoredCustomMascot = serde_json::from_slice(&bytes)?;
    if record.schema_version != CUSTOM_MASCOT_SCHEMA_VERSION
        || !record.mime.starts_with("image/")
        || record.data_base64.len() > (MAX_CUSTOM_MASCOT_BYTES as usize * 2)
    {
        return Err(CommandError::validation("invalid custom mascot store"));
    }
    Ok(Some(format!(
        "data:{};base64,{}",
        record.mime, record.data_base64
    )))
}

#[tauri::command]
pub async fn settings_clear_custom_mascot() -> CommandResult<()> {
    match fs::remove_file(crate::util::config_paths::custom_mascot_path()).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(CommandError::Io(format!(
            "remove custom mascot store failed: {error}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_mascot_accepts_raster_extensions_and_rejects_svg() {
        assert_eq!(custom_mascot_mime(Path::new("mascot.PNG")), Some("image/png"));
        assert_eq!(custom_mascot_mime(Path::new("mascot.webp")), Some("image/webp"));
        assert_eq!(custom_mascot_mime(Path::new("mascot.svg")), None);
    }
}

//! Issue #1193: project 画像 preview を global asset scope ではなく、files authz を通した
//! data URL で返す。old project root を asset:// へ追加し続ける権限漏れを防ぐ。

use serde::Serialize;
use tauri::AppHandle;

use super::root_gate::assert_workspace_project_root_via;
use super::safe_join;

/// data URL 化する画像 preview の上限。base64 化で約 4/3 に膨らむため、通常ファイルの
/// 50 MiB 上限を流用せず、renderer メモリを圧迫しない 10 MiB に抑える。
const MAX_IMAGE_PREVIEW_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileImageReadResult {
    pub ok: bool,
    pub error: Option<String>,
    pub data_url: Option<String>,
}

fn image_mime_type(path: &std::path::Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "avif" => Some("image/avif"),
        "bmp" => Some("image/bmp"),
        "ico" => Some("image/x-icon"),
        _ => None,
    }
}

// command-result-exempt: files_* 系の非 Result 契約 (renderer は ok/error 構造体を直接受ける,
// files.rs 冒頭コメント参照) に揃える。preview 失敗は placeholder 表示に落とすだけで
// CommandError の構造化 code を必要としない。
#[tauri::command]
pub async fn files_read_image(
    app: AppHandle,
    project_root: String,
    rel_path: String,
) -> FileImageReadResult {
    let project_root = match assert_workspace_project_root_via(&app, &project_root).await {
        Ok(root) => root,
        Err(error) => {
            return FileImageReadResult {
                ok: false,
                error: Some(error.to_string()),
                ..Default::default()
            };
        }
    };
    let Some(abs) = safe_join(&project_root, &rel_path) else {
        return FileImageReadResult {
            ok: false,
            error: Some("invalid path".into()),
            ..Default::default()
        };
    };
    let Some(mime) = image_mime_type(&abs) else {
        return FileImageReadResult {
            ok: false,
            error: Some("unsupported image type".into()),
            ..Default::default()
        };
    };
    let metadata = match tokio::fs::metadata(&abs).await {
        Ok(metadata) if metadata.is_file() => metadata,
        Ok(_) => {
            return FileImageReadResult {
                ok: false,
                error: Some("image path is not a file".into()),
                ..Default::default()
            };
        }
        Err(error) => {
            return FileImageReadResult {
                ok: false,
                error: Some(error.to_string()),
                ..Default::default()
            };
        }
    };
    if metadata.len() > MAX_IMAGE_PREVIEW_BYTES {
        return FileImageReadResult {
            ok: false,
            error: Some(format!(
                "image exceeds {} byte safety limit",
                MAX_IMAGE_PREVIEW_BYTES
            )),
            ..Default::default()
        };
    }
    let bytes = match tokio::fs::read(&abs).await {
        Ok(bytes) => bytes,
        Err(error) => {
            return FileImageReadResult {
                ok: false,
                error: Some(error.to_string()),
                ..Default::default()
            };
        }
    };
    // 最大 10 MiB の base64 encode は 10ms 超かかりうる CPU 仕事なので、tokio の async
    // ワーカーを塞がないよう blocking pool へ逃がす (PR #1202 review)。
    let encoded = match tokio::task::spawn_blocking(move || {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(bytes)
    })
    .await
    {
        Ok(encoded) => encoded,
        Err(error) => {
            return FileImageReadResult {
                ok: false,
                error: Some(format!("encode image failed: {error}")),
                ..Default::default()
            };
        }
    };
    FileImageReadResult {
        ok: true,
        error: None,
        data_url: Some(format!("data:{mime};base64,{encoded}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn image_preview_accepts_raster_formats_and_rejects_svg() {
        assert_eq!(image_mime_type(Path::new("photo.JPEG")), Some("image/jpeg"));
        assert_eq!(image_mime_type(Path::new("icon.webp")), Some("image/webp"));
        assert_eq!(image_mime_type(Path::new("vector.svg")), None);
        assert_eq!(image_mime_type(Path::new("no-extension")), None);
    }
}

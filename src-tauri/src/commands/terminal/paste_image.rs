// commands/terminal/paste_image.rs
//
// terminal.rs から move された純関数群 (Phase 3 / Issue #373)。
// PTY race とは無関係。

use super::SavePastedImageResult;

/// Issue #40: mime_type から拡張子を決める。未知 mime は .png にフォールバック。
/// Issue #138: SVG はスクリプト埋め込み可能な XML 形式で、AI agent が paste image
/// path を読みに行ったときにプロンプトインジェクション / XSS の足掛かりになる。
/// SVG は Option::None を返して保存自体を拒否させる。
fn extension_for_mime(mime: &str) -> Option<&'static str> {
    match mime.trim().to_ascii_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        "image/bmp" => Some("bmp"),
        "image/tiff" => Some("tiff"),
        // image/svg+xml は除外 (上記 issue 参照)
        // 未知 mime も拒否 (旧 fallback="png" は MIME 検証ザル経路だった)
        _ => None,
    }
}

/// Issue #41: paste-images/ 配下のうち mtime が 7 日以上古いファイルを削除。
/// paste の度に best-effort で呼ばれ、長期利用時のゴミ蓄積を防ぐ。
async fn cleanup_old_paste_images(dir: &std::path::Path) {
    // Issue #138: 旧 7 日 → 24h に短縮。情報残存リスクを下げる
    const TTL_SECS: u64 = 24 * 60 * 60;
    let Ok(mut rd) = tokio::fs::read_dir(dir).await else {
        return;
    };
    let now = std::time::SystemTime::now();
    while let Ok(Some(entry)) = rd.next_entry().await {
        let path = entry.path();
        let Ok(meta) = entry.metadata().await else {
            continue;
        };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        let age = now.duration_since(modified).unwrap_or_default();
        if age.as_secs() > TTL_SECS {
            let _ = tokio::fs::remove_file(&path).await;
        }
    }
}

/// Issue #138: paste image の最大サイズ。base64 decoded で 32 MB を超える payload は拒否。
/// 一般的なクリップボード画像 (4K スクショ PNG) は 5〜15 MB 程度なので余裕を持った上限。
const MAX_PASTED_IMAGE_BYTES: usize = 32 * 1024 * 1024;

pub async fn save(base64: String, mime_type: String) -> SavePastedImageResult {
    // Issue #138 (Security):
    //   1. base64 文字列の段階で max を超えるなら decode せずに reject (DoS / disk full 防止)
    //   2. MIME を allowlist (image/png|jpeg|webp|gif|bmp|tiff) に限定。SVG は禁止
    //   3. decoded size も二重に check (base64 padding 崩しを通った場合に備える)
    if base64.len() > MAX_PASTED_IMAGE_BYTES * 4 / 3 + 64 {
        return SavePastedImageResult {
            ok: false,
            path: None,
            error: Some("pasted image exceeds size limit (32 MB)".into()),
        };
    }
    let Some(ext) = extension_for_mime(&mime_type) else {
        return SavePastedImageResult {
            ok: false,
            path: None,
            error: Some(format!(
                "unsupported MIME type for pasted image: {mime_type}"
            )),
        };
    };
    use base64::Engine;
    let bytes = match base64::engine::general_purpose::STANDARD.decode(base64.as_bytes()) {
        Ok(b) => b,
        Err(e) => {
            return SavePastedImageResult {
                ok: false,
                path: None,
                error: Some(e.to_string()),
            }
        }
    };
    if bytes.len() > MAX_PASTED_IMAGE_BYTES {
        return SavePastedImageResult {
            ok: false,
            path: None,
            error: Some("pasted image exceeds size limit (32 MB)".into()),
        };
    }
    let dir = crate::util::config_paths::vibe_root().join("paste-images");
    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        return SavePastedImageResult {
            ok: false,
            path: None,
            error: Some(e.to_string()),
        };
    }

    // Issue #41: 古い画像を best-effort cleanup
    cleanup_old_paste_images(&dir).await;

    let name = format!("paste-{}.{ext}", uuid::Uuid::new_v4());
    let path = dir.join(&name);
    if let Err(e) = tokio::fs::write(&path, bytes).await {
        return SavePastedImageResult {
            ok: false,
            path: None,
            error: Some(e.to_string()),
        };
    }
    SavePastedImageResult {
        ok: true,
        path: Some(path.to_string_lossy().into_owned()),
        error: None,
    }
}

#[cfg(test)]
mod mime_ext_tests {
    use super::extension_for_mime;
    #[test]
    fn maps_common_image_mimes() {
        assert_eq!(extension_for_mime("image/png"), Some("png"));
        assert_eq!(extension_for_mime("image/jpeg"), Some("jpg"));
        assert_eq!(extension_for_mime("image/jpg"), Some("jpg"));
        assert_eq!(extension_for_mime("image/webp"), Some("webp"));
        assert_eq!(extension_for_mime("image/gif"), Some("gif"));
        assert_eq!(extension_for_mime("IMAGE/JPEG"), Some("jpg"));
        // Issue #138: SVG and unknown MIME are now rejected
        assert_eq!(extension_for_mime("image/svg+xml"), None);
        assert_eq!(extension_for_mime("application/x-mystery"), None);
    }
}

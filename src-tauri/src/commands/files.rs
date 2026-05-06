// files.* command — 旧 src/main/ipc/files.ts に対応
//
// 通常の fs 操作。tokio::fs を使い、エラーを ok=false で返す既存契約を維持。

mod encoding;
mod hash;
mod path_safety;

use serde::Serialize;
use std::path::Path;

use encoding::{detect_text_or_binary, encode_for_save};
use hash::{mtime_ms_of, sha256_hex};
// safe_join は外部 (commands/git.rs) からも呼ばれるので pub use で再 export する。
pub use path_safety::safe_join;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileListResult {
    pub ok: bool,
    pub error: Option<String>,
    pub dir: String,
    pub entries: Vec<FileNode>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileReadResult {
    pub ok: bool,
    pub error: Option<String>,
    pub path: String,
    pub content: String,
    pub is_binary: bool,
    pub encoding: String,
    /// Issue #65: open 時の mtime (ms since epoch)。save で外部変更検出に使う。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtime_ms: Option<u64>,
    /// Issue #104: open 時のファイルサイズ (bytes)。save で size mismatch も併用検出する。
    /// FS の mtime 解像度 (1 秒単位など) では 1 秒以内の変更を取り逃すため、size を併用する。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    /// Issue #119: open 時のファイル内容の SHA-256 (hex)。
    /// FS が秒精度しか持たず、かつ同サイズで上書きされた場合は mtime / size の両方で
    /// 検出を取りこぼすので、内容ハッシュを併用して conflict を見落とさないようにする。
    /// クライアントは write 時にこの値を `expected_content_hash` で送り返す。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileWriteResult {
    pub ok: bool,
    pub error: Option<String>,
    /// Issue #65: 書き込み後の mtime。次回 save 時の比較基準になる。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtime_ms: Option<u64>,
    /// Issue #104: 書き込み後のファイルサイズ。次回 save の比較基準になる。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    /// Issue #119: 書き込み後のファイル内容の SHA-256 (hex)。次回 save の比較基準。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
    /// Issue #65: 期待する mtime と現状が食い違った場合に true を返す。
    /// ok=false + conflict=true でフロントはユーザーに確認ダイアログを出す。
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub conflict: bool,
}

#[tauri::command]
pub async fn files_list(project_root: String, rel_path: String) -> FileListResult {
    let dir = safe_join(&project_root, &rel_path);
    let dir = match dir {
        Some(p) if p.is_dir() => p,
        _ => {
            return FileListResult {
                ok: false,
                error: Some("invalid path".into()),
                dir: rel_path,
                entries: vec![],
            }
        }
    };
    let mut entries = vec![];
    let mut rd = match tokio::fs::read_dir(&dir).await {
        Ok(r) => r,
        Err(e) => {
            return FileListResult {
                ok: false,
                error: Some(e.to_string()),
                dir: rel_path,
                entries: vec![],
            }
        }
    };
    // Issue #34: entry.path() は canonicalize された実パスを返すので、relative を取る
    // prefix は raw の project_root ではなく同じく canonicalize された root を使う必要がある。
    // Windows の junction / symlink / 大文字小文字違いで raw と real が食い違うと strip_prefix
    // が失敗して entry.path が空文字に落ちる。
    let canonical_root = Path::new(&project_root).canonicalize().ok();
    let root_ref = canonical_root.as_deref().unwrap_or_else(|| Path::new(&project_root));
    while let Ok(Some(entry)) = rd.next_entry().await {
        let p = entry.path();
        let is_dir = p.is_dir();
        let name = entry.file_name().to_string_lossy().into_owned();
        let rel = p
            .strip_prefix(root_ref)
            .map(|r| r.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        entries.push(FileNode {
            name,
            path: rel,
            is_dir,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    FileListResult {
        ok: true,
        error: None,
        dir: rel_path,
        entries,
    }
}

#[tauri::command]
pub async fn files_read(project_root: String, rel_path: String) -> FileReadResult {
    const MAX_READ_BYTES: u64 = 50 * 1024 * 1024;
    let Some(abs) = safe_join(&project_root, &rel_path) else {
        return FileReadResult {
            ok: false,
            error: Some("invalid path".into()),
            path: rel_path,
            ..Default::default()
        };
    };
    let meta = match tokio::fs::metadata(&abs).await {
        Ok(m) => m,
        Err(e) => {
            return FileReadResult {
                ok: false,
                error: Some(e.to_string()),
                path: rel_path,
                ..Default::default()
            }
        }
    };
    if meta.len() > MAX_READ_BYTES {
        return FileReadResult {
            ok: false,
            error: Some(format!(
                "file too large to open safely ({} bytes > {} bytes limit)",
                meta.len(),
                MAX_READ_BYTES
            )),
            path: rel_path,
            ..Default::default()
        };
    }
    let bytes = match tokio::fs::read(&abs).await {
        Ok(b) => b,
        Err(e) => {
            return FileReadResult {
                ok: false,
                error: Some(e.to_string()),
                path: rel_path,
                ..Default::default()
            }
        }
    };
    // Issue #45: 単純に NUL を含む = バイナリにすると UTF-16 / UTF-32 テキストが開けない。
    //   - UTF-16/32 は BOM (0xFF 0xFE, 0xFE 0xFF, 0x00 0x00 0xFE 0xFF 等) を持つので BOM 検出を優先
    //   - それ以外は「非テキスト char の割合」で判定: NUL の他に 0x01..0x08/0x0B/0x0E..0x1F を含む
    //     バイト比率が高いときだけバイナリ扱い。偽陽性を減らす。
    let (is_binary, content, encoding) = detect_text_or_binary(&bytes);
    // Issue #65 / #104: 開いた時点の mtime と size を返して、save 時の external-change 検出に使う
    // Issue #119: 加えて内容の SHA-256 を返す。FS が秒精度しか無く、かつ同サイズで書き換えられた
    // 場合に mtime/size 両方で見逃しても、内容ハッシュの不一致で conflict を確定できる。
    let mtime_ms = mtime_ms_of(&meta);
    let size_bytes = Some(meta.len());
    let content_hash = if !is_binary { Some(sha256_hex(&bytes)) } else { None };
    FileReadResult {
        ok: true,
        error: None,
        path: rel_path,
        content,
        is_binary,
        encoding,
        mtime_ms,
        size_bytes,
        content_hash,
    }
}

#[tauri::command]
pub async fn files_write(
    project_root: String,
    rel_path: String,
    content: String,
    // Issue #65: 前回 read 時の mtime_ms。指定時は save 直前に現在 mtime と比較して
    // 食い違いを検出する。未指定 (None) なら後方互換で検出をスキップ。
    expected_mtime_ms: Option<u64>,
    // Issue #104: 前回 read 時の size。mtime 解像度の粗い FS や 1 秒以内の連続変更の
    // 取りこぼし対策として併用する。
    expected_size_bytes: Option<u64>,
    // Issue #102: read 時の encoding。指定時はその encoding で再エンコードして書き戻す。
    // 未指定なら従来通り UTF-8。
    encoding: Option<String>,
    // Issue #119: 前回 read 時の SHA-256 (hex)。指定時は save 直前に現在ファイルの hash と比較し、
    // mtime/size を見逃した「同サイズ・1 秒以内」変更でも conflict を確定する。
    expected_content_hash: Option<String>,
) -> FileWriteResult {
    let Some(abs) = safe_join(&project_root, &rel_path) else {
        return FileWriteResult {
            ok: false,
            error: Some("invalid path".into()),
            ..Default::default()
        };
    };

    // Issue #102: 指定 encoding で再エンコード。lossy / binary は拒否。
    let encoding_str = encoding.as_deref().unwrap_or("");
    let bytes = match encode_for_save(&content, encoding_str) {
        Ok(b) => b,
        Err(e) => {
            return FileWriteResult {
                ok: false,
                error: Some(e),
                ..Default::default()
            }
        }
    };

    // Issue #65 / #104: 既存ファイルがある場合のみ external-change 検出
    if let Ok(meta) = tokio::fs::metadata(&abs).await {
        // Issue #104: mtime 比較は abs_diff で前後どちらのズレも検出する。
        // saturating_sub だと expected > current (時刻巻き戻り / 別 mtime のファイルへ
        // 差し替え) の場合に diff=0 で素通しされていた。
        if let Some(expected) = expected_mtime_ms {
            if let Some(current) = mtime_ms_of(&meta) {
                // 1 秒未満の誤差は無視 (一部 FS は秒精度しか持たないため)
                if current.abs_diff(expected) > 1000 {
                    return FileWriteResult {
                        ok: false,
                        error: Some("file changed on disk since it was opened".into()),
                        mtime_ms: Some(current),
                        size_bytes: Some(meta.len()),
                        conflict: true,
                        ..Default::default()
                    };
                }
            }
        }
        // Issue #104: size mismatch も conflict 扱い (mtime 解像度の補完)
        if let Some(expected_size) = expected_size_bytes {
            if meta.len() != expected_size {
                return FileWriteResult {
                    ok: false,
                    error: Some("file size changed on disk since it was opened".into()),
                    mtime_ms: mtime_ms_of(&meta),
                    size_bytes: Some(meta.len()),
                    conflict: true,
                    ..Default::default()
                };
            }
        }
        // Issue #119: 同サイズかつ 1 秒以内の編集は mtime/size 両方で見逃すため、
        // 期待ハッシュが渡ってきていれば現在ファイル内容とハッシュ比較する。
        if let Some(expected_hash) = expected_content_hash.as_deref() {
            if let Ok(current_bytes) = tokio::fs::read(&abs).await {
                let current_hash = sha256_hex(&current_bytes);
                if current_hash != expected_hash {
                    return FileWriteResult {
                        ok: false,
                        error: Some("file content changed on disk since it was opened".into()),
                        mtime_ms: mtime_ms_of(&meta),
                        size_bytes: Some(meta.len()),
                        content_hash: Some(current_hash),
                        conflict: true,
                    };
                }
            }
        }
    }

    if let Some(parent) = abs.parent() {
        if let Err(e) = tokio::fs::create_dir_all(parent).await {
            return FileWriteResult {
                ok: false,
                error: Some(e.to_string()),
                ..Default::default()
            };
        }
    }

    // Issue #103: 直接 fs::write だとクラッシュ時に半端書きが残る。atomic_write で
    // 同一ディレクトリ temp → fsync → rename 経由に置き換える。
    // symlink の場合は rename が symlink 自体を置き換えてしまうため、target を解決して
    // 実体パスに書き込む。
    let target_path = match tokio::fs::symlink_metadata(&abs).await {
        Ok(m) if m.file_type().is_symlink() => {
            // symlink を辿って実体を解決する。失敗時は元の path にフォールバック。
            tokio::fs::canonicalize(&abs).await.unwrap_or_else(|_| abs.clone())
        }
        _ => abs.clone(),
    };

    if let Err(e) = crate::commands::atomic_write::atomic_write(&target_path, &bytes).await {
        return FileWriteResult {
            ok: false,
            error: Some(e.to_string()),
            ..Default::default()
        };
    }

    let new_meta = tokio::fs::metadata(&target_path).await.ok();
    let mtime_ms = new_meta.as_ref().and_then(mtime_ms_of);
    let size_bytes = new_meta.as_ref().map(|m| m.len());
    // Issue #119: 書き込み後の hash も返す。次回 save の比較基準に使う。
    let content_hash = Some(sha256_hex(&bytes));
    FileWriteResult {
        ok: true,
        error: None,
        mtime_ms,
        size_bytes,
        content_hash,
        conflict: false,
    }
}

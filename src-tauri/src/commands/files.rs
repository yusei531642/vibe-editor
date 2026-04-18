// files.* command — 旧 src/main/ipc/files.ts に対応
//
// 通常の fs 操作。tokio::fs を使い、エラーを ok=false で返す既存契約を維持。

use serde::Serialize;
use std::path::{Component, Path, PathBuf};

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
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileWriteResult {
    pub ok: bool,
    pub error: Option<String>,
    /// Issue #65: 書き込み後の mtime。次回 save 時の比較基準になる。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtime_ms: Option<u64>,
    /// Issue #65: 期待する mtime と現状が食い違った場合に true を返す。
    /// ok=false + conflict=true でフロントはユーザーに確認ダイアログを出す。
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub conflict: bool,
}

fn mtime_ms_of(meta: &std::fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
}

/// Issue #45: UTF-16 / UTF-32 / CP932 等も「テキスト」として扱えるよう拡張した判定。
/// 戻り値: (is_binary, content, encoding)
fn detect_text_or_binary(bytes: &[u8]) -> (bool, String, String) {
    // --- BOM による UTF-16/32 判定 ---
    if bytes.starts_with(&[0xFF, 0xFE, 0x00, 0x00]) {
        // UTF-32 LE BOM (UTF-16 LE と prefix 被るので先にチェック)
        return utf32_decode(&bytes[4..], true)
            .map(|s| (false, s, "utf-32le".to_string()))
            .unwrap_or((true, String::new(), "binary".to_string()));
    }
    if bytes.starts_with(&[0x00, 0x00, 0xFE, 0xFF]) {
        return utf32_decode(&bytes[4..], false)
            .map(|s| (false, s, "utf-32be".to_string()))
            .unwrap_or((true, String::new(), "binary".to_string()));
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return utf16_decode(&bytes[2..], true)
            .map(|s| (false, s, "utf-16le".to_string()))
            .unwrap_or((true, String::new(), "binary".to_string()));
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return utf16_decode(&bytes[2..], false)
            .map(|s| (false, s, "utf-16be".to_string()))
            .unwrap_or((true, String::new(), "binary".to_string()));
    }
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        // UTF-8 BOM
        let body = &bytes[3..];
        return match std::str::from_utf8(body) {
            Ok(s) => (false, s.to_string(), "utf-8".to_string()),
            Err(_) => (
                false,
                String::from_utf8_lossy(body).into_owned(),
                "lossy".to_string(),
            ),
        };
    }

    // --- BOM なし: 非テキスト control char の割合で判定 ---
    // 先頭 8KB をサンプリング
    let sample = &bytes[..bytes.len().min(8192)];
    let non_text = sample
        .iter()
        .filter(|&&b| {
            b == 0x00
                || (b < 0x09)
                || b == 0x0B
                || b == 0x0C
                || (b >= 0x0E && b < 0x20 && b != 0x1B) // ESC (0x1B) は xterm 系で許容
        })
        .count();
    // 非テキスト率が 30% を超えるなら binary とみなす
    if sample.len() > 0 && non_text * 100 / sample.len() >= 30 {
        return (true, String::new(), "binary".to_string());
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => (false, s.to_string(), "utf-8".to_string()),
        Err(_) => (
            false,
            String::from_utf8_lossy(bytes).into_owned(),
            "lossy".to_string(),
        ),
    }
}

fn utf16_decode(bytes: &[u8], little_endian: bool) -> Option<String> {
    if bytes.len() % 2 != 0 {
        return None;
    }
    let mut units = Vec::with_capacity(bytes.len() / 2);
    for chunk in bytes.chunks_exact(2) {
        let u = if little_endian {
            u16::from_le_bytes([chunk[0], chunk[1]])
        } else {
            u16::from_be_bytes([chunk[0], chunk[1]])
        };
        units.push(u);
    }
    String::from_utf16(&units).ok()
}

fn utf32_decode(bytes: &[u8], little_endian: bool) -> Option<String> {
    if bytes.len() % 4 != 0 {
        return None;
    }
    let mut out = String::with_capacity(bytes.len() / 4);
    for chunk in bytes.chunks_exact(4) {
        let u = if little_endian {
            u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])
        } else {
            u32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])
        };
        match char::from_u32(u) {
            Some(c) => out.push(c),
            None => return None,
        }
    }
    Some(out)
}

#[cfg(test)]
mod detect_tests {
    use super::detect_text_or_binary;

    #[test]
    fn utf8_ascii_is_text() {
        let (bin, _, enc) = detect_text_or_binary(b"hello world");
        assert!(!bin);
        assert_eq!(enc, "utf-8");
    }

    #[test]
    fn utf16_le_with_bom_is_text() {
        // "hi" in UTF-16 LE with BOM
        let bytes = [0xFF, 0xFE, b'h', 0x00, b'i', 0x00];
        let (bin, content, enc) = detect_text_or_binary(&bytes);
        assert!(!bin);
        assert_eq!(content, "hi");
        assert_eq!(enc, "utf-16le");
    }

    #[test]
    fn pure_binary_is_binary() {
        // mostly control bytes
        let bytes: Vec<u8> = (0u8..40).collect();
        let (bin, _, enc) = detect_text_or_binary(&bytes);
        assert!(bin);
        assert_eq!(enc, "binary");
    }
}

/// 相対パスを root 配下に閉じ込める形で解決する。
///
/// 旧実装は `joined.canonicalize()` が失敗 (= 未作成ファイル) したとき `joined` をそのまま
/// `starts_with(&root)` に渡していたが、`Path::starts_with` はコンポーネント単位比較なので
/// `root/../outside.txt` のようなパスでも一致しすり抜ける (Issue #20)。
///
/// 正しい方針:
///   1. `rel` に絶対パス (Windows の `C:` prefix や POSIX の `/`) が含まれていたら拒否
///   2. コンポーネントを `.` / `..` / 通常成分に分解し、`..` が stack を空にする前に現れたら拒否
///      (root を脱出する `..`)
///   3. その上で物理 canonicalize を試み、symlink 解決後も root 配下であることを再確認
pub fn safe_join(root: &str, rel: &str) -> Option<PathBuf> {
    let root = Path::new(root).canonicalize().ok()?;
    let rel_path = Path::new(rel);

    // (1) 絶対パス混入を拒否
    if rel_path.is_absolute() {
        return None;
    }

    // (2) コンポーネント単位で仮想的に正規化 (fs 非依存)
    let mut stack: Vec<&std::ffi::OsStr> = Vec::new();
    for comp in rel_path.components() {
        match comp {
            Component::Normal(name) => stack.push(name),
            Component::CurDir => { /* "." は無視 */ }
            Component::ParentDir => {
                // root 直下で ".." が来たら脱出なので拒否
                if stack.pop().is_none() {
                    return None;
                }
            }
            // RootDir / Prefix / ... は絶対パス要素 → 既に (1) で弾いているが念のため拒否
            _ => return None,
        }
    }

    // 正規化後の joined パス (fs 実体は未作成かもしれない)
    let mut joined = root.clone();
    for c in &stack {
        joined.push(c);
    }

    // (3) 可能なら symlink 展開後も root 配下であることを再確認
    if let Ok(canonical) = joined.canonicalize() {
        if canonical.starts_with(&root) {
            return Some(canonical);
        }
        return None;
    }

    // 未作成ファイル → 親ディレクトリを canonicalize して確認
    match joined.parent().and_then(|p| p.canonicalize().ok()) {
        Some(parent_canonical) if parent_canonical.starts_with(&root) => {
            // 親が root 配下なら joined (ファイル名成分を付け直した絶対パス) を返す
            let name = joined.file_name()?;
            Some(parent_canonical.join(name))
        }
        _ => Some(joined).filter(|p| p.starts_with(&root)),
    }
}

#[cfg(test)]
mod safe_join_tests {
    use super::*;
    use std::fs;

    fn tempdir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("vibe-safe-join-{}", std::process::id()));
        let _ = fs::create_dir_all(&d);
        d.canonicalize().unwrap()
    }

    #[test]
    fn rejects_parent_escape() {
        let root = tempdir();
        let root_str = root.to_string_lossy();
        assert!(safe_join(&root_str, "../outside.txt").is_none());
        assert!(safe_join(&root_str, "a/../../outside.txt").is_none());
    }

    #[test]
    fn rejects_absolute() {
        let root = tempdir();
        let root_str = root.to_string_lossy();
        if cfg!(windows) {
            assert!(safe_join(&root_str, "C:\\Windows\\notepad.exe").is_none());
        } else {
            assert!(safe_join(&root_str, "/etc/passwd").is_none());
        }
    }

    #[test]
    fn allows_inside() {
        let root = tempdir();
        let root_str = root.to_string_lossy();
        assert!(safe_join(&root_str, "sub/file.txt").is_some());
        assert!(safe_join(&root_str, "a/../b.txt").is_some()); // 中間の .. は OK
        assert!(safe_join(&root_str, "./nested/./file.txt").is_some());
    }
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
    let abs = match safe_join(&project_root, &rel_path) {
        Some(p) => p,
        None => {
            return FileReadResult {
                ok: false,
                error: Some("invalid path".into()),
                path: rel_path,
                ..Default::default()
            }
        }
    };
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
    // Issue #65: 開いた時点の mtime を返して、save 時の external-change 検出に使う
    let mtime_ms = tokio::fs::metadata(&abs).await.ok().and_then(|m| mtime_ms_of(&m));
    FileReadResult {
        ok: true,
        error: None,
        path: rel_path,
        content,
        is_binary,
        encoding,
        mtime_ms,
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
) -> FileWriteResult {
    let abs = match safe_join(&project_root, &rel_path) {
        Some(p) => p,
        None => {
            return FileWriteResult {
                ok: false,
                error: Some("invalid path".into()),
                ..Default::default()
            }
        }
    };

    // Issue #65: expected_mtime_ms が指定されていて、ファイルが既にあるなら現在 mtime と比較
    if let Some(expected) = expected_mtime_ms {
        if let Ok(meta) = tokio::fs::metadata(&abs).await {
            if let Some(current) = mtime_ms_of(&meta) {
                // 1 秒未満の誤差は無視 (FS によって ms 精度が無いため)
                let diff = current.saturating_sub(expected);
                if diff > 1000 {
                    return FileWriteResult {
                        ok: false,
                        error: Some(
                            "file changed on disk since it was opened".into(),
                        ),
                        mtime_ms: Some(current),
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
    match tokio::fs::write(&abs, content).await {
        Ok(_) => {
            let mtime_ms = tokio::fs::metadata(&abs).await.ok().and_then(|m| mtime_ms_of(&m));
            FileWriteResult {
                ok: true,
                error: None,
                mtime_ms,
                conflict: false,
            }
        }
        Err(e) => FileWriteResult {
            ok: false,
            error: Some(e.to_string()),
            ..Default::default()
        },
    }
}

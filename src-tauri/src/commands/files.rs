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
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileWriteResult {
    pub ok: bool,
    pub error: Option<String>,
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
    let is_binary = bytes.contains(&0u8);
    let (content, encoding) = if is_binary {
        (String::new(), "binary".to_string())
    } else {
        match std::str::from_utf8(&bytes) {
            Ok(s) => (s.to_string(), "utf-8".to_string()),
            Err(_) => (String::from_utf8_lossy(&bytes).into_owned(), "lossy".to_string()),
        }
    };
    FileReadResult {
        ok: true,
        error: None,
        path: rel_path,
        content,
        is_binary,
        encoding,
    }
}

#[tauri::command]
pub async fn files_write(
    project_root: String,
    rel_path: String,
    content: String,
) -> FileWriteResult {
    let abs = match safe_join(&project_root, &rel_path) {
        Some(p) => p,
        None => {
            return FileWriteResult {
                ok: false,
                error: Some("invalid path".into()),
            }
        }
    };
    if let Some(parent) = abs.parent() {
        if let Err(e) = tokio::fs::create_dir_all(parent).await {
            return FileWriteResult {
                ok: false,
                error: Some(e.to_string()),
            };
        }
    }
    match tokio::fs::write(&abs, content).await {
        Ok(_) => FileWriteResult {
            ok: true,
            error: None,
        },
        Err(e) => FileWriteResult {
            ok: false,
            error: Some(e.to_string()),
        },
    }
}

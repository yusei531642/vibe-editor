// files.* command — 旧 src/main/ipc/files.ts に対応
//
// 通常の fs 操作。tokio::fs を使い、エラーを ok=false で返す既存契約を維持。

use serde::Serialize;
use std::path::{Path, PathBuf};

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

fn safe_join(root: &str, rel: &str) -> Option<PathBuf> {
    let root = Path::new(root).canonicalize().ok()?;
    let joined = root.join(rel);
    let canonical = joined.canonicalize().unwrap_or(joined);
    if canonical.starts_with(&root) {
        Some(canonical)
    } else {
        None
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
    let root = Path::new(&project_root);
    while let Ok(Some(entry)) = rd.next_entry().await {
        let p = entry.path();
        let is_dir = p.is_dir();
        let name = entry.file_name().to_string_lossy().into_owned();
        let rel = p
            .strip_prefix(root)
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

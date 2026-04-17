// git.* command — 旧 src/main/ipc/git.ts に対応
//
// 既存と同じく `git` バイナリを std::process::Command で execFile する方式。
// libgit2 (git2 crate) は採用しない理由:
// - バイナリサイズ増加 (libgit2 ~6MB)
// - submodule / worktree / hooks / config の挙動が `git` バイナリと完全互換ではない
// - 既存実装は status と diff のみで、シェル呼び出しのオーバーヘッドは無視できる

use serde::Serialize;
use tokio::process::Command;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    pub path: String,
    pub index_status: String,
    pub worktree_status: String,
    pub label: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub ok: bool,
    pub error: Option<String>,
    pub repo_root: Option<String>,
    pub branch: Option<String>,
    pub files: Vec<GitFileChange>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffResult {
    pub ok: bool,
    pub error: Option<String>,
    pub path: String,
    pub is_new: bool,
    pub is_deleted: bool,
    pub is_binary: bool,
    pub original: String,
    pub modified: String,
}

async fn run_git(args: &[&str], cwd: &str) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| format!("failed to spawn git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn label_from_status(idx: char, wt: char) -> &'static str {
    match (idx, wt) {
        ('?', '?') => "Untracked",
        (_, 'M') | ('M', _) => "Modified",
        (_, 'D') | ('D', _) => "Deleted",
        ('A', _) => "Added",
        ('R', _) => "Renamed",
        ('C', _) => "Copied",
        _ => "Changed",
    }
}

#[tauri::command]
pub async fn git_status(project_root: String) -> GitStatus {
    // repo root
    let repo_root = match run_git(&["rev-parse", "--show-toplevel"], &project_root).await {
        Ok(s) => s.trim().to_string(),
        Err(e) => {
            return GitStatus {
                ok: false,
                error: Some(e),
                ..Default::default()
            }
        }
    };
    let branch = run_git(&["rev-parse", "--abbrev-ref", "HEAD"], &project_root)
        .await
        .ok()
        .map(|s| s.trim().to_string());
    let porcelain = match run_git(&["status", "--porcelain"], &project_root).await {
        Ok(s) => s,
        Err(e) => {
            return GitStatus {
                ok: false,
                error: Some(e),
                repo_root: Some(repo_root),
                branch,
                ..Default::default()
            }
        }
    };
    let files = porcelain
        .lines()
        .filter_map(|line| {
            if line.len() < 3 {
                return None;
            }
            let bytes = line.as_bytes();
            let idx = bytes[0] as char;
            let wt = bytes[1] as char;
            let path = line[3..].to_string();
            Some(GitFileChange {
                path,
                index_status: idx.to_string(),
                worktree_status: wt.to_string(),
                label: label_from_status(idx, wt).to_string(),
            })
        })
        .collect();

    GitStatus {
        ok: true,
        error: None,
        repo_root: Some(repo_root),
        branch,
        files,
    }
}

#[tauri::command]
pub async fn git_diff(project_root: String, rel_path: String) -> GitDiffResult {
    // 旧実装と同じく `git diff -- <path>` ではなく、HEAD と worktree を別々に取って
    // Monaco DiffEditor が比較しやすい形式 (original / modified) に整形する。
    // ここでは簡略実装として cat-file HEAD:<path> + 現在ファイル内容を返す。
    let head = run_git(
        &["show", &format!("HEAD:{rel_path}")],
        &project_root,
    )
    .await;
    let is_new = matches!(&head, Err(e) if e.contains("does not exist") || e.contains("exists on disk, but not in"));
    let original = head.clone().unwrap_or_default();

    let abs = std::path::Path::new(&project_root).join(&rel_path);
    let modified = match tokio::fs::read_to_string(&abs).await {
        Ok(s) => s,
        Err(_) => String::new(),
    };
    let is_deleted = !abs.exists();
    let is_binary = original.contains('\u{0}') || modified.contains('\u{0}');

    GitDiffResult {
        ok: true,
        error: None,
        path: rel_path,
        is_new,
        is_deleted,
        is_binary,
        original,
        modified,
    }
}

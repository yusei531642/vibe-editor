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
    /// rename / copy の場合、HEAD 側 (移動前) のパス。通常は None。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
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

/// `git status --porcelain=v1 -z` の raw bytes を返す。
/// -z は NUL 区切りなので UTF-8 変換せず bytes 単位で返す必要がある。
async fn run_git_bytes(args: &[&str], cwd: &str) -> Result<Vec<u8>, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| format!("failed to spawn git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(out.stdout)
}

/// `--porcelain=v1 -z` の出力をパースする。
///
/// レコード形式:
///   - 通常: `XY ` + path + `\0`
///   - rename/copy: `XY ` + new_path + `\0` + old_path + `\0`
///
/// X == 'R' or 'C' (どちら側の列でも) の場合のみ 2 番目の NUL 区切りが old_path。
fn parse_porcelain_z(bytes: &[u8]) -> Vec<GitFileChange> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        // 最低 4 バイト (XY + space + path + NUL) が必要
        if bytes.len() < i + 4 {
            break;
        }
        let idx = bytes[i] as char;
        let wt = bytes[i + 1] as char;
        // bytes[i+2] は ' ' (space) のはず
        i += 3;

        // 次の NUL を探す
        let path_end = match bytes[i..].iter().position(|&b| b == 0) {
            Some(n) => i + n,
            None => break,
        };
        let new_path = String::from_utf8_lossy(&bytes[i..path_end]).into_owned();
        i = path_end + 1;

        // rename / copy なら続けて old_path が入っている
        let original_path = if matches!(idx, 'R' | 'C') || matches!(wt, 'R' | 'C') {
            match bytes[i..].iter().position(|&b| b == 0) {
                Some(n) => {
                    let old = String::from_utf8_lossy(&bytes[i..i + n]).into_owned();
                    i += n + 1;
                    Some(old)
                }
                None => None,
            }
        } else {
            None
        };

        out.push(GitFileChange {
            path: new_path,
            index_status: idx.to_string(),
            worktree_status: wt.to_string(),
            label: label_from_status(idx, wt).to_string(),
            original_path,
        });
    }
    out
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
    // Issue #19: -z (NUL 区切り) を使わないと rename が "old -> new" の 1 行として返り
    //            parser が解釈できない。`--porcelain=v1 -z` でバイト単位にパースする。
    let porcelain_bytes = match run_git_bytes(&["status", "--porcelain=v1", "-z"], &project_root).await {
        Ok(b) => b,
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
    let files = parse_porcelain_z(&porcelain_bytes);

    GitStatus {
        ok: true,
        error: None,
        repo_root: Some(repo_root),
        branch,
        files,
    }
}

#[tauri::command]
pub async fn git_diff(
    project_root: String,
    rel_path: String,
    // Issue #19: rename の場合、HEAD 側 (移動前) のパス。UI (GitFileChange.originalPath) から渡す。
    // 未指定なら rel_path を両側に使う (通常の変更)。
    original_rel_path: Option<String>,
) -> GitDiffResult {
    // 旧実装と同じく `git diff -- <path>` ではなく、HEAD と worktree を別々に取って
    // Monaco DiffEditor が比較しやすい形式 (original / modified) に整形する。
    let head_path = original_rel_path.as_deref().unwrap_or(&rel_path);
    let head = run_git(
        &["show", &format!("HEAD:{head_path}")],
        &project_root,
    )
    .await;
    let is_new = matches!(&head, Err(e) if e.contains("does not exist") || e.contains("exists on disk, but not in"));
    let original = head.clone().unwrap_or_default();

    // Issue #36: safe_join を通し、project_root の外を参照できないようにする。
    // head_path 側 (`git show HEAD:<path>`) は git 自身が worktree 外を拒否するが、
    // worktree 側 (fs 読み取り) は raw join だと `../../etc/passwd` を許してしまう。
    let abs = match crate::commands::files::safe_join(&project_root, &rel_path) {
        Some(p) => p,
        None => {
            return GitDiffResult {
                ok: false,
                error: Some("invalid path".into()),
                path: rel_path,
                ..Default::default()
            };
        }
    };
    // original_rel_path (rename の旧パス) も同様に検証する。
    if let Some(orig) = original_rel_path.as_deref() {
        if crate::commands::files::safe_join(&project_root, orig).is_none() {
            return GitDiffResult {
                ok: false,
                error: Some("invalid original path".into()),
                path: rel_path,
                ..Default::default()
            };
        }
    }
    // Issue #35: read_to_string() は非 UTF-8 で失敗し、worktree 側が空文字になって
    // diff が「全削除」に見えてしまう。raw bytes → from_utf8_lossy で落としどころを作る。
    let (modified, worktree_is_lossy) = match tokio::fs::read(&abs).await {
        Ok(bytes) => match std::str::from_utf8(&bytes) {
            Ok(s) => (s.to_string(), false),
            Err(_) => (String::from_utf8_lossy(&bytes).into_owned(), true),
        },
        Err(_) => (String::new(), false),
    };
    let is_deleted = !abs.exists();
    // NUL-byte を含むファイル、または非 UTF-8 (lossy) はバイナリ扱い (DiffEditor は placeholder)。
    let is_binary =
        original.contains('\u{0}') || modified.contains('\u{0}') || worktree_is_lossy;

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_rename_record() {
        // "R  newname\0oldname\0"
        let data = b"R  newname\0oldname\0";
        let v = parse_porcelain_z(data);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].path, "newname");
        assert_eq!(v[0].original_path.as_deref(), Some("oldname"));
        assert_eq!(v[0].index_status, "R");
    }

    #[test]
    fn parse_multiple_mixed() {
        // "M  a.txt\0R  new.rs\0old.rs\0?? untracked.bin\0"
        let data = b"M  a.txt\0R  new.rs\0old.rs\0?? untracked.bin\0";
        let v = parse_porcelain_z(data);
        assert_eq!(v.len(), 3);
        assert_eq!(v[0].path, "a.txt");
        assert!(v[0].original_path.is_none());
        assert_eq!(v[1].path, "new.rs");
        assert_eq!(v[1].original_path.as_deref(), Some("old.rs"));
        assert_eq!(v[2].path, "untracked.bin");
    }

    #[test]
    fn parse_path_with_spaces() {
        // -z はスペースを escape しないので "file with spaces.txt" がそのまま入る
        let data = b"M  file with spaces.txt\0";
        let v = parse_porcelain_z(data);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].path, "file with spaces.txt");
    }
}

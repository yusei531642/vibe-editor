// git.* command — 旧 src/main/ipc/git.ts に対応
//
// 既存と同じく `git` バイナリを std::process::Command で execFile する方式。
// libgit2 (git2 crate) は採用しない理由:
// - バイナリサイズ増加 (libgit2 ~6MB)
// - submodule / worktree / hooks / config の挙動が `git` バイナリと完全互換ではない
// - 既存実装は status と diff のみで、シェル呼び出しのオーバーヘッドは無視できる

use serde::Serialize;
use tokio::process::Command;

/// Windows で GUI アプリ (Tauri) からコンソールプロセス (git.exe) を起動すると、
/// 既定では一瞬コンソールウィンドウが表示されてしまう。
/// `CREATE_NO_WINDOW = 0x08000000` を付けると窓を作らずに起動できる。
/// 起動時に Canvas の各カードから git status / diff が呼ばれるたびに点滅していたのを抑止する。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn new_git_command() -> Command {
    let cmd = Command::new("git");
    #[cfg(windows)]
    let mut cmd = cmd;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

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
    let out = new_git_command()
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
///
/// Issue #174: 巨大 monorepo で porcelain 出力が数十〜数百 MB 達する場合に備えて、
/// stdout を pipe で受け取りつつ MAX_STDOUT_BYTES でハードキャップ。超過したら
/// child を kill して残りを切り捨てる (renderer 側は entries が途中まで取れる)。
async fn run_git_bytes(args: &[&str], cwd: &str) -> Result<Vec<u8>, String> {
    use std::process::Stdio;
    use tokio::io::AsyncReadExt;

    const MAX_STDOUT_BYTES: usize = 16 * 1024 * 1024; // 16 MiB

    let mut child = new_git_command()
        .args(args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn git: {e}"))?;

    let mut stdout_pipe = child
        .stdout
        .take()
        .ok_or_else(|| "git stdout pipe missing".to_string())?;
    let mut stderr_pipe = child.stderr.take();

    let mut buf = Vec::with_capacity(64 * 1024);
    let mut chunk = [0u8; 64 * 1024];
    let mut truncated = false;
    loop {
        match stdout_pipe.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => {
                if buf.len() + n > MAX_STDOUT_BYTES {
                    let remaining = MAX_STDOUT_BYTES - buf.len();
                    if remaining > 0 {
                        buf.extend_from_slice(&chunk[..remaining]);
                    }
                    truncated = true;
                    let _ = child.kill().await;
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
            }
            Err(_) => break,
        }
    }

    let status = child.wait().await.map_err(|e| e.to_string())?;
    if !status.success() && !truncated {
        let mut stderr_buf = Vec::new();
        if let Some(ref mut s) = stderr_pipe {
            let _ = s.read_to_end(&mut stderr_buf).await;
        }
        return Err(String::from_utf8_lossy(&stderr_buf).into_owned());
    }
    if truncated {
        tracing::warn!(
            "[git] stdout truncated at {} bytes (porcelain output exceeded soft cap)",
            MAX_STDOUT_BYTES
        );
    }
    Ok(buf)
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

    // Issue #134 (Security): head_path は `git show HEAD:<head_path>` で git に渡る。
    //   - 旧実装は safe_join 検証より先に git に渡していたため、
    //     originalRelPath="../../.env" のようなペイロードで repo root 直下の任意の
    //     HEAD blob を読み取れてしまっていた。
    //   - safe_join() を git 呼び出しの「前」に移動し、境界外のパスは早期 reject する。
    //   - 加えて head_path が "-" で始まる場合 (CLI option 偽装) も拒否する。
    //     `HEAD:-foo` は git 的には rev spec の一部だが、防御的に弾いておく。
    let head_path = original_rel_path.as_deref().unwrap_or(&rel_path);
    if head_path.starts_with('-') || head_path.contains("..")
        || crate::commands::files::safe_join(&project_root, head_path).is_none()
    {
        return GitDiffResult {
            ok: false,
            error: Some("invalid head path".into()),
            path: rel_path,
            ..Default::default()
        };
    }

    // Issue #36: rel_path が ".." を含むと project_root の外を読めてしまうため safe_join を通す。
    // safe_join が None (= 境界外 / absolute / 不正) の場合は empty にしてエラー扱い。
    let abs = match crate::commands::files::safe_join(&project_root, &rel_path) {
        Some(p) => p,
        None => {
            return GitDiffResult {
                ok: false,
                error: Some("invalid relative path".into()),
                path: rel_path,
                ..Default::default()
            };
        }
    };

    // Issue #154 #1: project_root が submodule / worktree 内のとき、cwd を project_root に
    // して `git show HEAD:` を回すと git は親リポを見て head_path 不在として誤判定する。
    // `git rev-parse --show-toplevel` で「このリポの本物のトップ」を求めて cwd にする。
    let repo_root = run_git(&["rev-parse", "--show-toplevel"], &project_root)
        .await
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| project_root.clone());

    // git の HEAD blob path は repo_root 相対なので、project_root → repo_root の差分を埋める。
    // safe_join 後に repo_root に含まれるかどうかを確認し、相対化する。
    let abs_head_target = match crate::commands::files::safe_join(&project_root, head_path) {
        Some(p) => p,
        None => {
            return GitDiffResult {
                ok: false,
                error: Some("invalid head path".into()),
                path: rel_path,
                ..Default::default()
            };
        }
    };
    let head_path_for_git = match abs_head_target.strip_prefix(&repo_root) {
        Ok(p) => p.to_string_lossy().replace('\\', "/"),
        Err(_) => head_path.to_string(),
    };

    // Issue #154 #3: is_new 判定を i18n 不依存にする。
    // `git ls-tree HEAD -- <path>` の stdout が空なら HEAD に存在しない。
    let ls_tree = run_git(
        &["ls-tree", "HEAD", "--", &head_path_for_git],
        &repo_root,
    )
    .await
    .unwrap_or_default();
    let is_new = ls_tree.trim().is_empty();

    // Issue #154 #2: 巨大ファイルでの OOM 防止。`git cat-file -s HEAD:<path>` でサイズを
    // 先に取り、5 MB を超えるなら head 取得をスキップして binary 扱いにする。
    const MAX_DIFF_BYTES: usize = 5 * 1024 * 1024;
    let head_size: usize = run_git(
        &["cat-file", "-s", &format!("HEAD:{head_path_for_git}")],
        &repo_root,
    )
    .await
    .ok()
    .and_then(|s| s.trim().parse().ok())
    .unwrap_or(0);
    let head_too_large = head_size > MAX_DIFF_BYTES;

    let head = if head_too_large || is_new {
        // 大きすぎ / 新規 → HEAD 取得しない (binary placeholder で表示)
        Err("(skipped: file too large or new)".to_string())
    } else {
        run_git(
            &["show", &format!("HEAD:{head_path_for_git}")],
            &repo_root,
        )
        .await
    };
    let original = head.clone().unwrap_or_default();
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
    // NUL-byte を含むファイル、または非 UTF-8 (lossy)、巨大ファイル時は バイナリ扱い。
    let is_binary = head_too_large
        || modified.len() > MAX_DIFF_BYTES
        || original.contains('\u{0}')
        || modified.contains('\u{0}')
        || worktree_is_lossy;

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

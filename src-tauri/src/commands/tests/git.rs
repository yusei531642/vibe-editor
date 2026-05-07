//! Issue #494: `commands::git` の integration test。
//!
//! 本物の `git` バイナリで初期化した tempdir 配下の fixture repo に対して
//! `git_status` / `git_diff` を走らせる。
//!
//! 実行マシンに `git` が無い CI 環境でも skip するため、各 test は冒頭で
//! `git --version` を `which git` ではなく `Command::new("git").arg("--version").status()`
//! で確認し、不在なら early return する (= "ok-skip" 扱い)。

use crate::commands::git::{git_diff, git_status};
use std::path::Path;
use std::process::Command;
use tempfile::tempdir;

/// `git` バイナリが PATH にあるか軽量チェック。CI / 実機どちらでも `git --version` で十分。
fn git_available() -> bool {
    Command::new("git")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// fixture repo: `git init` + identity 設定 + 初回 commit までを行う最小ヘルパ。
/// global hook / GPG / fsmonitor を自リポ内で off にして CI に依存しないようにする。
fn init_fixture_repo(dir: &Path) {
    let run = |args: &[&str]| {
        let status = Command::new("git")
            .args(args)
            .current_dir(dir)
            .status()
            .expect("git command failed");
        assert!(status.success(), "git {:?} failed", args);
    };
    run(&["init", "--initial-branch=main"]);
    run(&["config", "user.email", "test@example.com"]);
    run(&["config", "user.name", "Test"]);
    run(&["config", "commit.gpgsign", "false"]);
    run(&["config", "tag.gpgsign", "false"]);
}

fn commit_all(dir: &Path, message: &str) {
    let run = |args: &[&str]| {
        let status = Command::new("git")
            .args(args)
            .current_dir(dir)
            .status()
            .expect("git command failed");
        assert!(status.success(), "git {:?} failed", args);
    };
    run(&["add", "-A"]);
    run(&["commit", "-m", message, "--no-verify"]);
}

#[tokio::test]
async fn git_status_reports_modified_and_untracked_files() {
    if !git_available() {
        eprintln!("[git_test] git not available, skipping");
        return;
    }
    let dir = tempdir().unwrap();
    init_fixture_repo(dir.path());

    // 初期 commit
    tokio::fs::write(dir.path().join("a.txt"), b"hello\n")
        .await
        .unwrap();
    commit_all(dir.path(), "init");

    // a.txt を modify、b.txt を新規追加
    tokio::fs::write(dir.path().join("a.txt"), b"hello\nworld\n")
        .await
        .unwrap();
    tokio::fs::write(dir.path().join("b.txt"), b"new file\n")
        .await
        .unwrap();

    let project_root = dir.path().to_string_lossy().to_string();
    let status = git_status(project_root).await;
    assert!(status.ok, "git_status failed: {:?}", status.error);
    assert!(status.repo_root.is_some());
    assert_eq!(status.branch.as_deref(), Some("main"));
    let paths: Vec<&str> = status.files.iter().map(|f| f.path.as_str()).collect();
    assert!(paths.contains(&"a.txt"), "expected a.txt in status");
    assert!(paths.contains(&"b.txt"), "expected b.txt in status");
    let modified = status.files.iter().find(|f| f.path == "a.txt").unwrap();
    assert_eq!(modified.label, "Modified");
    let untracked = status.files.iter().find(|f| f.path == "b.txt").unwrap();
    assert_eq!(untracked.label, "Untracked");
}

#[tokio::test]
async fn git_diff_returns_head_and_worktree_for_modified_file() {
    if !git_available() {
        return;
    }
    let dir = tempdir().unwrap();
    init_fixture_repo(dir.path());
    tokio::fs::write(dir.path().join("README.md"), b"line1\nline2\n")
        .await
        .unwrap();
    commit_all(dir.path(), "init");
    // 編集
    tokio::fs::write(dir.path().join("README.md"), b"line1\nLINE2\nline3\n")
        .await
        .unwrap();

    let res = git_diff(
        dir.path().to_string_lossy().to_string(),
        "README.md".into(),
        None,
    )
    .await;
    assert!(res.ok);
    assert!(!res.is_new);
    assert!(!res.is_deleted);
    assert!(!res.is_binary);
    assert_eq!(res.original.lines().count(), 2);
    assert_eq!(res.modified.lines().count(), 3);
    assert!(res.original.contains("line2"));
    assert!(res.modified.contains("LINE2"));
}

#[tokio::test]
async fn git_diff_marks_new_file_as_is_new() {
    if !git_available() {
        return;
    }
    let dir = tempdir().unwrap();
    init_fixture_repo(dir.path());
    tokio::fs::write(dir.path().join("a.txt"), b"hello\n")
        .await
        .unwrap();
    commit_all(dir.path(), "init");
    // 新規 untracked file
    tokio::fs::write(dir.path().join("new.txt"), b"new content\n")
        .await
        .unwrap();

    let res = git_diff(
        dir.path().to_string_lossy().to_string(),
        "new.txt".into(),
        None,
    )
    .await;
    assert!(res.ok);
    assert!(res.is_new, "untracked file must be marked is_new");
    // is_new の場合 head は "(skipped: file too large or new)" になり original は空文字
    assert_eq!(res.original, "");
    assert!(res.modified.contains("new content"));
}

#[tokio::test]
async fn git_diff_rejects_path_traversal_attempt() {
    if !git_available() {
        return;
    }
    let dir = tempdir().unwrap();
    init_fixture_repo(dir.path());
    tokio::fs::write(dir.path().join("a.txt"), b"x\n")
        .await
        .unwrap();
    commit_all(dir.path(), "init");

    // Issue #134 で塞いだ traversal 攻撃 (rel_path = "../../.env" 等) を再現。
    let res = git_diff(
        dir.path().to_string_lossy().to_string(),
        "../etc/passwd".into(),
        None,
    )
    .await;
    assert!(!res.ok, "traversal must reject");
    assert!(res.error.unwrap().contains("invalid"));
}

#[tokio::test]
async fn git_diff_rejects_head_path_starting_with_dash() {
    if !git_available() {
        return;
    }
    let dir = tempdir().unwrap();
    init_fixture_repo(dir.path());
    tokio::fs::write(dir.path().join("a.txt"), b"x\n")
        .await
        .unwrap();
    commit_all(dir.path(), "init");

    // CLI option 偽装: original_rel_path が "-foo" のようなとき early reject。
    let res = git_diff(
        dir.path().to_string_lossy().to_string(),
        "a.txt".into(),
        Some("-foo".into()),
    )
    .await;
    assert!(!res.ok);
    assert!(res.error.unwrap().contains("invalid head path"));
}

#[tokio::test]
async fn git_status_returns_ok_false_on_non_repo_directory() {
    if !git_available() {
        return;
    }
    // git init していない tempdir → rev-parse --show-toplevel が失敗するはず
    let dir = tempdir().unwrap();
    let project_root = dir.path().to_string_lossy().to_string();
    let status = git_status(project_root).await;
    assert!(!status.ok);
    assert!(status.error.is_some());
}

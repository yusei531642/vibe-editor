//! Issue #739: 旧 `lib.rs` 内に inline 同居していた `log_prune_tests` mod を分離。
//!
//! `prune_old_log_files` / `LOG_KEEP_DAYS` は `lib.rs` のクレートルート private 項目なので
//! `src-tauri/tests/` の integration test (= public API しか触れない) には移せない。
//! `commands/tests/` / `pty/tests/` と同じく「本体ファイルとは別ファイルの in-crate test mod」
//! としてクレートルートの子モジュールに置くことで、private 項目への `super::` アクセスを
//! 保ったまま `lib.rs` 本体から大きなテスト塊を切り離す。
//!
//! Issue #643: ログ世代 GC (`prune_old_log_files`) の挙動を検証する。

use super::{prune_old_log_files, LOG_KEEP_DAYS};
use std::fs;
use std::time::{Duration, SystemTime};

/// Issue #643: 14 日より古い `vibe-editor.log*` は削除され、
/// 新しいファイルや無関係ファイルは残ることを確認する。
#[test]
fn prunes_only_old_vibe_editor_log_files() {
    let dir = tempfile::tempdir().expect("tempdir");

    let old_dated = dir.path().join("vibe-editor.log.2020-01-01");
    let old_legacy = dir.path().join("vibe-editor.log");
    let recent_dated = dir.path().join("vibe-editor.log.2099-12-31");
    let unrelated = dir.path().join("other.log");
    let unrelated_old = dir.path().join("readme.txt");

    for f in [
        &old_dated,
        &old_legacy,
        &recent_dated,
        &unrelated,
        &unrelated_old,
    ] {
        fs::write(f, b"x").unwrap();
    }

    // 古い 2 ファイルと「無関係だが古い」ファイルの mtime を 30 日前に倒す。
    let way_old = SystemTime::now() - Duration::from_secs(60 * 60 * 24 * 30);
    for f in [&old_dated, &old_legacy, &unrelated_old] {
        let file = fs::File::options().write(true).open(f).unwrap();
        file.set_modified(way_old).unwrap();
    }

    prune_old_log_files(dir.path(), LOG_KEEP_DAYS);

    assert!(!old_dated.exists(), "old dated log should be pruned");
    assert!(!old_legacy.exists(), "legacy single log should be pruned");
    assert!(recent_dated.exists(), "recent log must survive");
    assert!(unrelated.exists(), "non-log file must survive");
    assert!(
        unrelated_old.exists(),
        "files outside vibe-editor.log* prefix must not be touched"
    );
}

/// 存在しないディレクトリを渡しても panic しない (起動を失敗させない契約)。
#[test]
fn prune_is_noop_on_missing_dir() {
    let dir = tempfile::tempdir().expect("tempdir");
    let missing = dir.path().join("does-not-exist");
    prune_old_log_files(&missing, LOG_KEEP_DAYS);
}

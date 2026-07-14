//! `vibe_team_skill.rs` の unit test 本体。file-size ratchet (Issue #939) のため
//! 実装本体と分離して配置する。`super` 経由で親モジュールの private item を検証する。

use super::*;
use crate::commands::atomic_write::atomic_write;
use tokio::fs;
use arc_swap::ArcSwapOption;
use std::sync::Arc;

/// 指定の本文を temp dir 配下の `.claude/skills/vibe-team/SKILL.md` に書き出す。
async fn write_skill(root: &Path, body: &str) {
    let dir = skill_dir(root);
    fs::create_dir_all(&dir).await.unwrap();
    atomic_write(&skill_path(root), body.as_bytes())
        .await
        .unwrap();
}

/// `<!-- vibe-team-skill-version: VER -->` ヘッダ付きの本文を組み立てる。
fn versioned(ver: &str, extra_body: &str) -> String {
    format!("<!-- vibe-team-skill-version: {ver} -->\n{extra_body}\n")
}

fn active_root(path: Option<&Path>) -> ArcSwapOption<String> {
    ArcSwapOption::from(path.map(|path| Arc::new(path.to_string_lossy().into_owned())))
}

async fn active_identity(
    path: Option<&Path>,
) -> ArcSwapOption<crate::commands::project_authority::ProjectRootIdentity> {
    let identity = match path {
        Some(path) => crate::commands::project_authority::capture_identity(path)
            .await
            .ok(),
        None => None,
    };
    ArcSwapOption::from(identity.map(Arc::new))
}

#[tokio::test]
async fn active_root_install_preserves_result_contract() {
    let project = tempfile::tempdir().expect("project");
    let slot = active_root(Some(project.path()));
    let identity = active_identity(Some(project.path())).await;

    let result = install_skill_for_active_root(
        &slot,
        &identity,
        project.path().to_string_lossy().as_ref(),
        false,
    )
    .await;

    assert!(result.ok);
    assert!(!result.skipped);
    assert!(!result.overwritten);
    assert!(result.error.is_none());
    let canonical_project = tokio::fs::canonicalize(project.path())
        .await
        .expect("canonical project");
    let expected_path = skill_path(&canonical_project);
    assert_eq!(
        result.path.as_deref(),
        Some(expected_path.to_string_lossy().as_ref())
    );
}

#[tokio::test]
async fn active_root_install_rejects_empty_missing_and_mismatch() {
    let active = tempfile::tempdir().expect("active");
    let foreign = tempfile::tempdir().expect("foreign");
    let slot = active_root(Some(active.path()));
    let identity = active_identity(Some(active.path())).await;

    let empty = install_skill_for_active_root(&slot, &identity, "  ", false).await;
    assert!(!empty.ok);
    assert_eq!(empty.error.as_deref(), Some("project_root is empty"));

    let unconfigured_root = active_root(None);
    let unconfigured_identity = active_identity(None).await;
    let unconfigured = install_skill_for_active_root(
        &unconfigured_root,
        &unconfigured_identity,
        active.path().to_string_lossy().as_ref(),
        false,
    )
    .await;
    assert!(!unconfigured.ok);
    assert_eq!(
        unconfigured.error.as_deref(),
        Some("no active project_root configured")
    );

    let missing_path = active.path().join("missing");
    let missing = install_skill_for_active_root(
        &slot,
        &identity,
        missing_path.to_string_lossy().as_ref(),
        false,
    )
    .await;
    assert!(!missing.ok);
    assert!(missing
        .error
        .as_deref()
        .is_some_and(|error| error.starts_with("canonicalize requested project_root failed:")));

    let mismatch = install_skill_for_active_root(
        &slot,
        &identity,
        foreign.path().to_string_lossy().as_ref(),
        false,
    )
    .await;
    assert!(!mismatch.ok);
    assert_eq!(
        mismatch.error.as_deref(),
        Some("project_root does not match active project")
    );
    assert!(!skill_path(foreign.path()).exists());
}

/// Issue #1109: bundled 本文 (SKILL_VERSION + vibe_team_skill_body.md) と、リポジトリの
/// 正本 `.claude/skills/vibe-team/SKILL.md` が再び別文書に乖離しないことを CI で固定する。
/// 正本を更新したら `tail -n +2 SKILL.md > vibe_team_skill_body.md` で bundled を再生成し、
/// SKILL_VERSION と正本ヘッダを同時に bump すること。
#[test]
fn bundled_text_matches_repo_canonical_skill_md() {
    // include_str! なのでファイル移動時はコンパイルエラーで気付ける。
    // Windows で autocrlf=true な checkout でも比較が壊れないよう CRLF は正規化する
    // (materialize 時に書かれるのは current_skill_text() 側なので実挙動には影響しない)。
    let canonical =
        include_str!("../../../../.claude/skills/vibe-team/SKILL.md").replace("\r\n", "\n");
    let bundled = current_skill_text().replace("\r\n", "\n");
    assert_eq!(
        bundled, canonical,
        "bundled (SKILL_VERSION + vibe_team_skill_body.md) と正本 .claude/skills/vibe-team/SKILL.md が乖離しています。\
         正本を編集した場合は `tail -n +2 .claude/skills/vibe-team/SKILL.md > src-tauri/src/commands/vibe_team_skill_body.md` \
         で bundled を再生成し、SKILL_VERSION を bump してください (Issue #1109)"
    );
}

#[test]
fn parse_skill_version_reads_header() {
    assert_eq!(
        parse_skill_version("<!-- vibe-team-skill-version: 1.6.4 -->\nbody"),
        Some((1, 6, 4))
    );
    // ヘッダ無しは None。
    assert_eq!(parse_skill_version("just a user note\nbody"), None);
    // 非数値 / 桁数違いは None (保守的に従来挙動へ)。
    assert_eq!(
        parse_skill_version("<!-- vibe-team-skill-version: 1.x.0 -->"),
        None
    );
    assert_eq!(
        parse_skill_version("<!-- vibe-team-skill-version: 1.6 -->"),
        None
    );
}

/// (1) on-disk が bundled より新しい場合、force=true でも縮退上書きせず skip する。
#[tokio::test]
async fn newer_on_disk_is_not_downgraded_even_with_force() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    // bundled SKILL_VERSION より確実に新しい版を on-disk に置く。
    let newer = versioned("99.0.0", "DISK NEWER BODY — must be preserved");
    write_skill(root, &newer).await;

    let result = install_skill_at(root, true).await;

    assert!(result.ok, "install should report ok");
    assert!(result.skipped, "newer on-disk must be skipped");
    assert!(
        !result.overwritten,
        "newer on-disk must NOT be overwritten (downgrade guard)"
    );
    let after = fs::read_to_string(skill_path(root)).await.unwrap();
    assert_eq!(after, newer, "on-disk content must be left untouched");
}

/// (2) on-disk が同等以下の版なら force で bundled 本文が配置される (従来挙動)。
#[tokio::test]
async fn older_on_disk_is_replaced_with_force() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let older = versioned("0.0.1", "OLD DISK BODY");
    write_skill(root, &older).await;

    let result = install_skill_at(root, true).await;

    assert!(result.ok, "install should report ok");
    assert!(result.overwritten, "older on-disk must be overwritten");
    assert!(!result.skipped, "older on-disk must not be skipped");
    let after = fs::read_to_string(skill_path(root)).await.unwrap();
    assert_eq!(after, current_skill_text(), "bundled text must be written");
}

/// (3) ヘッダ無し + force=false なら従来通りユーザー編集として保護 (skip) する。
#[tokio::test]
async fn headerless_on_disk_is_protected_without_force() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let user_edited = "ユーザーが手で書いた SKILL.md\nバージョンヘッダ無し\n";
    write_skill(root, user_edited).await;

    let result = install_skill_at(root, false).await;

    assert!(result.ok, "install should report ok");
    assert!(result.skipped, "headerless user edit must be skipped");
    assert!(
        !result.overwritten,
        "headerless user edit must not be overwritten"
    );
    let after = fs::read_to_string(skill_path(root)).await.unwrap();
    assert_eq!(after, user_edited, "user-edited content must be preserved");
}

/// (4) 同一バージョン境界: disk_ver == bundled SKILL_VERSION のとき、#1108 ガードは
/// strict `>` のため不発。現行版ヘッダを持つファイルは従来の refresh 経路に入り、
/// 縮退は起きず bundled 本文へ揃う (版は同一のまま = ダウングレードしない)。
#[tokio::test]
async fn same_version_on_disk_is_refreshed_not_downgraded() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    // 現行版ヘッダ付きだが body が bundled と異なる on-disk (本文だけ微編集された状態)。
    let same_version = versioned(SKILL_VERSION, "SAME VERSION header, slightly edited body");
    write_skill(root, &same_version).await;

    let result = install_skill_at(root, false).await;

    assert!(result.ok, "install should report ok");
    // strict `>` 比較なので #1108 ガードは発火せず、skip 経路には入らない。
    assert!(
        !result.skipped,
        "same-version must not hit the downgrade-skip path"
    );
    // 現行版ヘッダ持ち → 従来通り bundled で refresh される。
    assert!(
        result.overwritten,
        "same-version is refreshed to bundled (not a downgrade)"
    );
    let after = fs::read_to_string(skill_path(root)).await.unwrap();
    assert_eq!(
        after,
        current_skill_text(),
        "content must match bundled (same version → refresh, no downgrade)"
    );
    // 書き込まれた版が bundled と同一であること (= 縮退していない) を明示的に確認。
    assert_eq!(parse_skill_version(&after), parse_semver(SKILL_VERSION));
}

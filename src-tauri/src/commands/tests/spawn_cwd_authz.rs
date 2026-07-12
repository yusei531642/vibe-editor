//! Issue #1200: PTY spawn 境界の cwd fresh identity 再照合の回帰テスト。
//!
//! resume が返した canonical cwd と spawn の間に同一 path の directory が置換される
//! check-to-use gap を、TTL キャッシュを使わない再照合で fail-closed に塞ぐことを固定する。

use crate::commands::authz::assert_spawn_cwd_identity;
use crate::commands::project_authority::ProjectRootIdentity;
use arc_swap::ArcSwapOption;
use std::sync::Arc;
use tempfile::tempdir;

async fn slots_for(
    root: &std::path::Path,
) -> (
    ArcSwapOption<String>,
    ArcSwapOption<ProjectRootIdentity>,
    ProjectRootIdentity,
) {
    let identity = crate::commands::project_authority::capture_identity(root)
        .await
        .unwrap();
    let root_slot = ArcSwapOption::from(Some(Arc::new(identity.canonical_root.clone())));
    let identity_slot = ArcSwapOption::from(Some(Arc::new(identity.clone())));
    (root_slot, identity_slot, identity)
}

/// 置換されていない active root への spawn は通る。
#[tokio::test]
async fn intact_active_root_cwd_is_allowed() {
    let sandbox = tempdir().unwrap();
    let root = sandbox.path().join("project");
    tokio::fs::create_dir_all(&root).await.unwrap();
    let (root_slot, identity_slot, _) = slots_for(&root).await;

    assert_spawn_cwd_identity(&root_slot, &identity_slot, root.to_string_lossy().as_ref())
        .await
        .unwrap();
}

/// activate 後に同一 path の directory が置換されたら、TTL キャッシュの状態に関わらず
/// spawn 直前の fresh 再照合で拒否する (Issue #1200 の本体)。
#[tokio::test]
async fn replaced_active_root_cwd_is_rejected_before_spawn() {
    let sandbox = tempdir().unwrap();
    let root = sandbox.path().join("project");
    let parked = sandbox.path().join("parked");
    tokio::fs::create_dir_all(&root).await.unwrap();
    let (root_slot, identity_slot, identity) = slots_for(&root).await;

    // 通常 IPC 相当の照合を先に成功させ、TTL キャッシュが温まった状態を作る。
    assert_spawn_cwd_identity(&root_slot, &identity_slot, root.to_string_lossy().as_ref())
        .await
        .unwrap();

    // 同一 path のまま directory を置換する (= resume 返却後の rename/delete + 再作成)。
    tokio::fs::rename(&root, &parked).await.unwrap();
    tokio::fs::create_dir_all(&root).await.unwrap();
    let replaced = crate::commands::project_authority::capture_identity(&root)
        .await
        .unwrap();
    assert_ne!(identity, replaced, "fixture premise");

    let error =
        assert_spawn_cwd_identity(&root_slot, &identity_slot, root.to_string_lossy().as_ref())
            .await
            .expect_err("replaced directory must not be spawnable");
    assert_eq!(error.code(), "authz");
}

/// active root と identity が両方未設定でも、project 管理外 cwd は従来どおり通る。
#[tokio::test]
async fn out_of_project_cwd_is_out_of_scope() {
    let sandbox = tempdir().unwrap();
    let cwd = sandbox.path().join("scratch");
    tokio::fs::create_dir_all(&cwd).await.unwrap();
    let root_slot: ArcSwapOption<String> = ArcSwapOption::from(None);
    let identity_slot: ArcSwapOption<ProjectRootIdentity> = ArcSwapOption::from(None);

    assert_spawn_cwd_identity(&root_slot, &identity_slot, cwd.to_string_lossy().as_ref())
        .await
        .unwrap();
}

/// active root と同一 directory なのに native identity が無い場合は fail-closed。
#[tokio::test]
async fn active_root_without_identity_is_rejected() {
    let sandbox = tempdir().unwrap();
    let root = sandbox.path().join("project");
    tokio::fs::create_dir_all(&root).await.unwrap();
    let (root_slot, _identity_slot, _) = slots_for(&root).await;
    let empty_identity: ArcSwapOption<ProjectRootIdentity> = ArcSwapOption::from(None);

    let error =
        assert_spawn_cwd_identity(&root_slot, &empty_identity, root.to_string_lossy().as_ref())
            .await
            .expect_err("identity-less active root must not be spawnable");
    assert_eq!(error.code(), "authz");
}

/// 検証中に cwd が消えた場合も推測せず拒否する。
#[tokio::test]
async fn vanished_cwd_is_rejected() {
    let sandbox = tempdir().unwrap();
    let root = sandbox.path().join("project");
    tokio::fs::create_dir_all(&root).await.unwrap();
    let (root_slot, identity_slot, _) = slots_for(&root).await;
    let missing = sandbox.path().join("missing");

    let error = assert_spawn_cwd_identity(
        &root_slot,
        &identity_slot,
        missing.to_string_lossy().as_ref(),
    )
    .await
    .expect_err("missing cwd must not be spawnable");
    assert_eq!(error.code(), "authz");
}

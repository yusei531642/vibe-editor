//! `project_authority.rs` (private ledger) の unit test 本体。file-size ratchet
//! (Issue #939) のため実装本体と分離して配置する。

use super::*;
use tempfile::tempdir;

#[tokio::test]
async fn ledger_roundtrip_is_private_and_versioned() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("project-authority.json");
    let root = dir.path().join("project");
    tokio::fs::create_dir_all(&root).await.unwrap();
    let identity = capture_identity(root).await.unwrap();
    let ledger = ProjectAuthorityLedger {
        schema_version: PROJECT_AUTHORITY_SCHEMA_VERSION,
        active: Some(identity.clone()),
        workspace_roots: vec![identity],
    };
    write_ledger_to(&path, &ledger).await.unwrap();
    assert_eq!(load_ledger_from(&path).await.unwrap().active, ledger.active);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[tokio::test]
async fn missing_ledger_does_not_migrate_renderer_settings_candidates() {
    let dir = tempdir().unwrap();
    let missing = dir.path().join("project-authority.json");
    let ledger = load_ledger_from(&missing).await.unwrap();
    assert!(ledger.active.is_none());
    assert!(ledger.workspace_roots.is_empty());
    assert_eq!(ledger.schema_version, PROJECT_AUTHORITY_SCHEMA_VERSION);
}

#[test]
fn workspace_recheck_cache_serves_positive_only_until_invalidated() {
    invalidate_workspace_recheck();
    assert!(!workspace_recently_verified("/tmp/ws"));
    record_workspace_verified("/tmp/ws".to_string());
    assert!(workspace_recently_verified("/tmp/ws"));
    // 未検証の key はヒットしない (負の結果はキャッシュされない)。
    assert!(!workspace_recently_verified("/tmp/other"));
    // ledger mutation (write_ledger) 相当の破棄で即座に失効する。
    invalidate_workspace_recheck();
    assert!(!workspace_recently_verified("/tmp/ws"));
}

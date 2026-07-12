//! Issue #1147: team_history_list のstrict active-root gateとpre-STORE順序の回帰テスト。

use crate::commands::team_history::{
    filter_team_history_entries, team_history_list_via, TeamHistoryEntry,
};
use arc_swap::ArcSwapOption;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tempfile::tempdir;

fn active_slot(path: Option<&std::path::Path>) -> ArcSwapOption<String> {
    ArcSwapOption::from(path.map(|path| Arc::new(path.to_string_lossy().into_owned())))
}

async fn team_history_list_via_native_identity<R, Reader, Fut>(
    slot: &ArcSwapOption<String>,
    requested: String,
    reader: Reader,
) -> crate::commands::error::CommandResult<R>
where
    Reader: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = R>,
{
    let identity = match crate::state::current_project_root(slot) {
        Some(root) => crate::commands::project_authority::capture_identity(root)
            .await
            .ok(),
        None => None,
    };
    let identity_slot = ArcSwapOption::from(identity.map(Arc::new));
    team_history_list_via(slot, &identity_slot, requested, reader).await
}

fn entry(id: &str, project_root: &str) -> TeamHistoryEntry {
    TeamHistoryEntry {
        id: id.to_string(),
        name: format!("team-{id}"),
        project_root: project_root.to_string(),
        created_at: "2026-07-11T00:00:00Z".to_string(),
        last_used_at: "2026-07-11T00:00:00Z".to_string(),
        members: Vec::new(),
        organization: None,
        canvas_state: None,
        latest_handoff: None,
        orchestration: None,
    }
}

async fn assert_authz_rejection_skips_store_reader(
    slot: &ArcSwapOption<String>,
    requested: String,
) {
    let called = AtomicBool::new(false);
    let result = team_history_list_via_native_identity(slot, requested, |_target| async {
        called.store(true, Ordering::SeqCst);
        vec![entry("must-not-run", "/foreign")]
    })
    .await;
    let error = match result {
        Err(error) => error,
        Ok(_) => panic!("unauthorized root must reject instead of returning []"),
    };
    assert_eq!(error.code(), "authz");
    assert!(
        !called.load(Ordering::SeqCst),
        "STORE/list reader ran before authz"
    );
}

#[tokio::test]
async fn team_history_list_active_root_returns_reader_result() {
    let active = tempdir().unwrap();
    let active_raw = active.path().to_string_lossy().into_owned();
    let slot = active_slot(Some(active.path()));
    let result = team_history_list_via_native_identity(
        &slot,
        active_raw.clone(),
        move |target| async move {
        filter_team_history_entries(&target, &[entry("active", &active_raw)])
        },
    )
    .await
    .unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].id, "active");
}

/// empty / active未設定 / missing request・active / foreign mismatch はAuthzで拒否し、
/// STORE lock・ensure_loaded・fingerprint/disk readを内包するreaderを呼ばない。
#[tokio::test]
async fn team_history_list_rejections_never_call_store_reader() {
    let active = tempdir().unwrap();
    let foreign = tempdir().unwrap();
    let slot = active_slot(Some(active.path()));

    assert_authz_rejection_skips_store_reader(&slot, "  ".to_string()).await;
    assert_authz_rejection_skips_store_reader(
        &active_slot(None),
        active.path().to_string_lossy().into_owned(),
    )
    .await;
    assert_authz_rejection_skips_store_reader(
        &slot,
        active.path().join("missing").to_string_lossy().into_owned(),
    )
    .await;
    assert_authz_rejection_skips_store_reader(
        &active_slot(Some(&active.path().join("missing-active"))),
        active.path().to_string_lossy().into_owned(),
    )
    .await;
    assert_authz_rejection_skips_store_reader(&slot, foreign.path().to_string_lossy().into_owned())
        .await;
}

/// requested表記がcanonical aliasでもstrict gateを通り、gate時canonical identityで
/// active entryを返す。selectorにrequested rawを保存しないことを固定する。
#[tokio::test]
async fn team_history_list_canonical_alias_returns_active_entry() {
    let active = tempdir().unwrap();
    let active_raw = active.path().to_string_lossy().into_owned();
    let alias_raw = active.path().join(".").to_string_lossy().into_owned();
    let slot = active_slot(Some(active.path()));

    let result = team_history_list_via_native_identity(&slot, alias_raw, move |target| async move {
        filter_team_history_entries(
            &target,
            &[
                entry("active", &active_raw),
                entry("foreign", "/definitely-not-the-active-project"),
            ],
        )
    })
    .await
    .unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].id, "active");
}

/// gate後にactive raw symlinkが別projectへretargetされても、STORE待ち後のselectorは
/// gate時active raw snapshot keyから変化せず、既存raw形式のactive履歴を返す。
#[cfg(unix)]
#[tokio::test]
async fn team_history_list_symlink_retarget_keeps_gate_time_identity() {
    use std::os::unix::fs::symlink;

    let sandbox = tempdir().unwrap();
    let active = sandbox.path().join("active");
    let foreign = sandbox.path().join("foreign");
    let active_link = sandbox.path().join("current");
    tokio::fs::create_dir_all(&active).await.unwrap();
    tokio::fs::create_dir_all(&foreign).await.unwrap();
    symlink(&active, &active_link).unwrap();
    let requested = active_link.to_string_lossy().into_owned();
    let active_raw = requested.clone();
    let slot = active_slot(Some(&active_link));

    let result = team_history_list_via_native_identity(&slot, requested, move |target| async move {
        std::fs::remove_file(&active_link).unwrap();
        symlink(&foreign, &active_link).unwrap();
        filter_team_history_entries(
            &target,
            &[
                entry("active", &active_raw),
                entry("foreign", foreign.to_string_lossy().as_ref()),
            ],
        )
    })
    .await
    .unwrap();

    assert_eq!(result.len(), 1);
    assert_eq!(result[0].id, "active");
}

/// requestedがactiveへのaliasでも、selectorはrequested rawを採用せずgate時active raw
/// snapshotを使う。active rootが通常pathの場合、alias表記のentryを選択してはならない。
#[cfg(unix)]
#[tokio::test]
async fn team_history_list_requested_alias_uses_active_raw_snapshot_key() {
    use std::os::unix::fs::symlink;

    let sandbox = tempdir().unwrap();
    let active = sandbox.path().join("active");
    let requested_alias = sandbox.path().join("requested-alias");
    tokio::fs::create_dir_all(&active).await.unwrap();
    symlink(&active, &requested_alias).unwrap();
    let active_raw = active.to_string_lossy().into_owned();
    let alias_raw = requested_alias.to_string_lossy().into_owned();
    let slot = active_slot(Some(&active));

    let result = team_history_list_via_native_identity(
        &slot,
        alias_raw.clone(),
        move |target| async move {
        assert_eq!(target, active_raw);
        filter_team_history_entries(
            &target,
            &[
                entry("active", &active_raw),
                entry("alias-must-not-select", &alias_raw),
            ],
        )
        },
    )
    .await
    .unwrap();

    assert_eq!(result.len(), 1);
    assert_eq!(result[0].id, "active");
}

/// foreign projectを指していた履歴entryのraw symlinkがlist中にactiveへ差し替えられても、
/// entry側を再canonicalizeしてforeign metadataを返してはならない。
#[cfg(unix)]
#[tokio::test]
async fn team_history_list_retargeted_foreign_symlink_entry_is_not_disclosed() {
    use std::os::unix::fs::symlink;

    let sandbox = tempdir().unwrap();
    let active = sandbox.path().join("active");
    let foreign = sandbox.path().join("foreign");
    let historical_link = sandbox.path().join("historical-link");
    tokio::fs::create_dir_all(&active).await.unwrap();
    tokio::fs::create_dir_all(&foreign).await.unwrap();
    // このentryはforeignを指していた時点に保存されたもの。
    symlink(&foreign, &historical_link).unwrap();
    let historical_raw = historical_link.to_string_lossy().into_owned();
    let slot = active_slot(Some(&active));

    let result = team_history_list_via_native_identity(
        &slot,
        active.to_string_lossy().into_owned(),
        move |target| async move {
            std::fs::remove_file(&historical_link).unwrap();
            symlink(&active, &historical_link).unwrap();
            filter_team_history_entries(&target, &[entry("foreign", &historical_raw)])
        },
    )
    .await
    .unwrap();

    assert!(result.is_empty());
}

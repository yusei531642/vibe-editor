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
    Reader: FnOnce(crate::commands::team_history::ActiveHistoryScope) -> Fut,
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
        project_identity: None,
    }
}

async fn assert_authz_rejection_skips_store_reader(
    slot: &ArcSwapOption<String>,
    requested: String,
) {
    let called = AtomicBool::new(false);
    let result = team_history_list_via_native_identity(slot, requested, |_scope| async {
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
        move |scope| async move {
        filter_team_history_entries(&scope, &[entry("active", &active_raw)])
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

    let result = team_history_list_via_native_identity(&slot, alias_raw, move |scope| async move {
        filter_team_history_entries(
            &scope,
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

    let result = team_history_list_via_native_identity(&slot, requested, move |scope| async move {
        std::fs::remove_file(&active_link).unwrap();
        symlink(&foreign, &active_link).unwrap();
        filter_team_history_entries(
            &scope,
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
        move |scope| async move {
        assert_eq!(scope.raw_key, active_raw);
        filter_team_history_entries(
            &scope,
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
        move |scope| async move {
            std::fs::remove_file(&historical_link).unwrap();
            symlink(&active, &historical_link).unwrap();
            filter_team_history_entries(&scope, &[entry("foreign", &historical_raw)])
        },
    )
    .await
    .unwrap();

    assert!(result.is_empty());
}

// ---- Issue #1194: mutation (save / save_batch / delete) の gate 順序と fail-closed ----

use crate::commands::team_history::mutate::team_history_mutation_via;

async fn team_history_mutation_via_native_identity<R, Writer, Fut>(
    slot: &ArcSwapOption<String>,
    entry_project_roots: &[&str],
    writer: Writer,
) -> crate::commands::error::CommandResult<R>
where
    Writer: FnOnce(crate::commands::team_history::ActiveHistoryScope) -> Fut,
    Fut: std::future::Future<Output = R>,
{
    let identity = match crate::state::current_project_root(slot) {
        Some(root) => crate::commands::project_authority::capture_identity(root)
            .await
            .ok(),
        None => None,
    };
    let identity_slot = ArcSwapOption::from(identity.map(Arc::new));
    team_history_mutation_via(slot, &identity_slot, entry_project_roots, writer).await
}

async fn assert_mutation_rejection_skips_writer(
    slot: &ArcSwapOption<String>,
    entry_project_roots: &[&str],
) {
    let called = AtomicBool::new(false);
    let result =
        team_history_mutation_via_native_identity(slot, entry_project_roots, |_scope| async {
            called.store(true, Ordering::SeqCst);
            "must-not-run"
        })
        .await;
    let error = match result {
        Err(error) => error,
        Ok(_) => panic!("unauthorized mutation must reject instead of writing"),
    };
    assert_eq!(error.code(), "authz");
    assert!(
        !called.load(Ordering::SeqCst),
        "STORE/hydration writer ran before authz"
    );
}

/// active 一致の mutation は gate を通り、gate 時 active raw snapshot key を writer に渡す。
#[tokio::test]
async fn team_history_mutation_active_root_passes_snapshot_key_to_writer() {
    let active = tempdir().unwrap();
    let active_raw = active.path().to_string_lossy().into_owned();
    let slot = active_slot(Some(active.path()));
    let expected = active_raw.clone();

    let target = team_history_mutation_via_native_identity(
        &slot,
        &[active_raw.as_str()],
        |scope| async move { scope },
    )
    .await
    .unwrap();
    // gate 時 active raw snapshot key (= slot 値の I/O なし正規化) と一致すること。
    assert_eq!(
        target.raw_key,
        crate::commands::team_history::list::normalize_stored_project_root(&expected)
    );
    // Issue #1192: writer には gate と同一 snapshot の approval identity が渡ること。
    assert!(!target.identity.platform_file_id.is_empty());
}

/// empty / active 未設定 / missing / foreign は authz で拒否し、writer (STORE lock /
/// disk write / hydration を内包) を一切呼ばない。
#[tokio::test]
async fn team_history_mutation_rejections_never_call_writer() {
    let active = tempdir().unwrap();
    let foreign = tempdir().unwrap();
    let slot = active_slot(Some(active.path()));
    let active_raw = active.path().to_string_lossy().into_owned();
    let foreign_raw = foreign.path().to_string_lossy().into_owned();
    let missing_raw = active.path().join("missing").to_string_lossy().into_owned();

    assert_mutation_rejection_skips_writer(&slot, &["  "]).await;
    assert_mutation_rejection_skips_writer(&slot, &[]).await;
    assert_mutation_rejection_skips_writer(&active_slot(None), &[active_raw.as_str()]).await;
    assert_mutation_rejection_skips_writer(&slot, &[missing_raw.as_str()]).await;
    assert_mutation_rejection_skips_writer(&slot, &[foreign_raw.as_str()]).await;
}

/// batch 内に 1 entry でも別 project が混ざれば、gate (identity 照合) にも進まず全体 reject。
#[tokio::test]
async fn team_history_mutation_mixed_project_batch_is_rejected() {
    let active = tempdir().unwrap();
    let foreign = tempdir().unwrap();
    let slot = active_slot(Some(active.path()));
    let active_raw = active.path().to_string_lossy().into_owned();
    let foreign_raw = foreign.path().to_string_lossy().into_owned();

    assert_mutation_rejection_skips_writer(
        &slot,
        &[active_raw.as_str(), foreign_raw.as_str(), active_raw.as_str()],
    )
    .await;
}

/// canonical には一致する alias 表記 (末尾 "/." 等) でも、raw key が active と異なる entry は
/// 拒否する。alias で保存すると active raw の list から見えない孤児履歴になるため。
#[tokio::test]
async fn team_history_mutation_alias_notation_is_rejected() {
    let active = tempdir().unwrap();
    let slot = active_slot(Some(active.path()));
    let alias_raw = active.path().join(".").to_string_lossy().into_owned();

    assert_mutation_rejection_skips_writer(&slot, &[alias_raw.as_str()]).await;
}

// ---- Issue #1192: entry 単位の project identity 照合 ----

/// directory 置換 (同一 path・別 filesystem object) 後、旧 identity 時代の entry は
/// 新 identity の scope では列挙されない。identity 無しの legacy entry は互換で通る。
#[tokio::test]
async fn history_from_replaced_directory_is_not_attributed_to_new_identity() {
    use crate::commands::team_history::list::normalize_stored_project_root;
    use crate::commands::team_history::ActiveHistoryScope;

    let sandbox = tempdir().unwrap();
    let root = sandbox.path().join("project");
    let parked = sandbox.path().join("parked");
    tokio::fs::create_dir_all(&root).await.unwrap();
    let old_identity = crate::commands::project_authority::capture_identity(&root)
        .await
        .unwrap();
    // 同一 path のまま directory を置換する (= symlink retarget / restore 相当)。
    tokio::fs::rename(&root, &parked).await.unwrap();
    tokio::fs::create_dir_all(&root).await.unwrap();
    let new_identity = crate::commands::project_authority::capture_identity(&root)
        .await
        .unwrap();
    assert_ne!(old_identity, new_identity, "fixture premise");

    let raw = root.to_string_lossy().into_owned();
    let scope = ActiveHistoryScope {
        raw_key: normalize_stored_project_root(&raw),
        identity: new_identity.clone(),
    };
    let mut stale = entry("stale-era", &raw);
    stale.project_identity = Some(old_identity);
    let mut current = entry("current-era", &raw);
    current.project_identity = Some(new_identity);
    let legacy = entry("legacy-no-identity", &raw);

    let listed = filter_team_history_entries(&scope, &[stale, current, legacy]);
    let ids: Vec<&str> = listed.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(ids, vec!["current-era", "legacy-no-identity"]);
}

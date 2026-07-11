//! Issue #1147: `sessions_list` の active project 認可と非開示境界の回帰テスト。

use crate::commands::sessions::{sessions_list_from_home, sessions_list_via, SessionInfo};
use crate::pty::path_norm::encode_project_path;
use arc_swap::ArcSwapOption;
use serde_json::json;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tempfile::tempdir;

async fn write_jsonl(path: &PathBuf, lines: &[serde_json::Value]) {
    let body = lines
        .iter()
        .map(|v| serde_json::to_string(v).unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    tokio::fs::write(path, body).await.unwrap();
}

fn active_slot(path: Option<&std::path::Path>) -> ArcSwapOption<String> {
    ArcSwapOption::from(path.map(|path| Arc::new(path.to_string_lossy().into_owned())))
}

fn fake_session(id: &str) -> SessionInfo {
    SessionInfo {
        id: id.to_string(),
        path: format!("/{id}.jsonl"),
        title: format!("title-{id}"),
        message_count: 1,
        message_count_capped: false,
        last_modified_at: "2026-07-11T00:00:00Z".to_string(),
        last_modified_ms: 1,
    }
}

async fn assert_authz_rejection_skips_reader(slot: &ArcSwapOption<String>, requested: String) {
    let called = AtomicBool::new(false);
    let result = sessions_list_via(slot, requested, |_authorized| async {
        called.store(true, Ordering::SeqCst);
        vec![fake_session("must-not-run")]
    })
    .await;
    let error = match result {
        Err(error) => error,
        Ok(_) => panic!("unauthorized root must reject instead of returning []"),
    };
    assert_eq!(error.code(), "authz");
    assert!(!called.load(Ordering::SeqCst), "reader ran before authz");
}

/// Issue #1147: active project の成功値は CommandResult の Ok 内で従来どおり返す。
#[tokio::test]
async fn sessions_list_active_root_returns_reader_result() {
    let active = tempdir().unwrap();
    let slot = active_slot(Some(active.path()));
    let result = sessions_list_via(
        &slot,
        active.path().to_string_lossy().into_owned(),
        |_authorized| async { vec![fake_session("active")] },
    )
    .await
    .unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].id, "active");
}

/// Issue #1147: empty / active未設定 / missing request / foreign mismatch はすべて
/// Authz で拒否し、directory reader を一度も呼ばない。
#[tokio::test]
async fn sessions_list_rejections_never_call_reader() {
    let active = tempdir().unwrap();
    let foreign = tempdir().unwrap();
    let slot = active_slot(Some(active.path()));

    assert_authz_rejection_skips_reader(&slot, "   ".to_string()).await;
    assert_authz_rejection_skips_reader(
        &active_slot(None),
        active.path().to_string_lossy().into_owned(),
    )
    .await;
    assert_authz_rejection_skips_reader(
        &slot,
        active.path().join("missing").to_string_lossy().into_owned(),
    )
    .await;
    assert_authz_rejection_skips_reader(&slot, foreign.path().to_string_lossy().into_owned()).await;
}

/// Issue #1147 design review: 旧fail-open時は canonical alias の requested raw を Claude
/// directory key に使うと、cwd欠落 JSONLから別directoryのtitleを返せた。現行はgateと
/// 同じsnapshotの active rawだけをencodingに使うことをcanaryで固定する。
#[tokio::test]
async fn sessions_list_canonical_alias_reads_only_active_raw_directory() {
    let active = tempdir().unwrap();
    let home = tempdir().unwrap();
    let active_raw = active.path().to_string_lossy().into_owned();
    let alias_raw = active.path().join(".").to_string_lossy().into_owned();
    assert_ne!(
        encode_project_path(&active_raw),
        encode_project_path(&alias_raw),
        "fixture must exercise distinct Claude directory keys"
    );

    let active_dir = home
        .path()
        .join(".claude/projects")
        .join(encode_project_path(&active_raw));
    let alias_dir = home
        .path()
        .join(".claude/projects")
        .join(encode_project_path(&alias_raw));
    tokio::fs::create_dir_all(&active_dir).await.unwrap();
    tokio::fs::create_dir_all(&alias_dir).await.unwrap();
    write_jsonl(
        &active_dir.join("active.jsonl"),
        &[json!({
            "type": "user",
            "cwd": active_raw,
            "message": { "content": "active title" }
        })],
    )
    .await;
    // cwd欠落のforeign JSONLも、requested alias側directoryを選ばないため到達しない。
    write_jsonl(
        &alias_dir.join("secret.jsonl"),
        &[json!({
            "type": "user",
            "message": { "content": "foreign secret title" }
        })],
    )
    .await;

    let slot = active_slot(Some(active.path()));
    let home_path = home.path().to_path_buf();
    let result = sessions_list_via(&slot, alias_raw, move |authorized| {
        sessions_list_from_home(authorized, home_path)
    })
    .await
    .unwrap();

    assert_eq!(result.len(), 1);
    assert_eq!(result[0].id, "active");
    assert_eq!(result[0].title, "active title");
}

/// Issue #1147: active raw自体がsymlinkでも、gate後のretargetでcwd selectorを
/// foreign projectへ差し替えられない。JSONLの既存cwdはgate時canonicalまたはactive raw
/// snapshotのpure keyだけを許可し、後続canonicalizeはしない。
#[cfg(unix)]
#[tokio::test]
async fn sessions_list_symlink_retarget_keeps_gate_time_canonical_identity() {
    use std::os::unix::fs::symlink;

    let sandbox = tempdir().unwrap();
    let active = sandbox.path().join("active");
    let foreign = sandbox.path().join("foreign");
    let active_link = sandbox.path().join("current");
    tokio::fs::create_dir_all(&active).await.unwrap();
    tokio::fs::create_dir_all(&foreign).await.unwrap();
    symlink(&active, &active_link).unwrap();

    let home = tempdir().unwrap();
    let active_raw = active_link.to_string_lossy().into_owned();
    let active_canonical = std::fs::canonicalize(&active)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let project_dir = home
        .path()
        .join(".claude/projects")
        .join(encode_project_path(&active_raw));
    tokio::fs::create_dir_all(&project_dir).await.unwrap();
    // active rawで保存された既存JSONLと、canonical cwdで保存されたJSONLの両方を維持する。
    write_jsonl(
        &project_dir.join("active-raw.jsonl"),
        &[json!({
            "type": "user",
            "cwd": active_raw,
            "message": { "content": "active raw title" }
        })],
    )
    .await;
    write_jsonl(
        &project_dir.join("active-canonical.jsonl"),
        &[json!({
            "type": "user",
            "cwd": active_canonical,
            "message": { "content": "active canonical title" }
        })],
    )
    .await;
    write_jsonl(
        &project_dir.join("secret.jsonl"),
        &[json!({
            "type": "user",
            "cwd": foreign.to_string_lossy(),
            "message": { "content": "foreign secret title" }
        })],
    )
    .await;

    let slot = active_slot(Some(&active_link));
    let home_path = home.path().to_path_buf();
    let result = sessions_list_via(&slot, active_raw, move |authorized| async move {
        std::fs::remove_file(&active_link).unwrap();
        symlink(&foreign, &active_link).unwrap();
        sessions_list_from_home(authorized, home_path).await
    })
    .await
    .unwrap();

    let ids: Vec<&str> = result.iter().map(|session| session.id.as_str()).collect();
    assert_eq!(result.len(), 2, "returned ids: {ids:?}");
    assert!(ids.contains(&"active-raw"));
    assert!(ids.contains(&"active-canonical"));
}

/// encoded project directoryが衝突した場合でも、foreignを指していたcwd symlinkがlist中に
/// activeへretargetされてforeign titleを返すことはない。
#[cfg(unix)]
#[tokio::test]
async fn sessions_list_retargeted_foreign_cwd_symlink_is_not_disclosed() {
    use std::os::unix::fs::symlink;

    let sandbox = tempdir().unwrap();
    let active = sandbox.path().join("active");
    let foreign = sandbox.path().join("foreign");
    let foreign_cwd_link = sandbox.path().join("foreign-cwd-link");
    tokio::fs::create_dir_all(&active).await.unwrap();
    tokio::fs::create_dir_all(&foreign).await.unwrap();
    symlink(&foreign, &foreign_cwd_link).unwrap();

    let home = tempdir().unwrap();
    let active_raw = active.to_string_lossy().into_owned();
    // Collision済みのClaude directoryにforeign sessionが混在した状況を作る。
    let project_dir = home
        .path()
        .join(".claude/projects")
        .join(encode_project_path(&active_raw));
    tokio::fs::create_dir_all(&project_dir).await.unwrap();
    write_jsonl(
        &project_dir.join("active.jsonl"),
        &[json!({
            "type": "user",
            "cwd": active_raw,
            "message": { "content": "active title" }
        })],
    )
    .await;
    let foreign_cwd_raw = foreign_cwd_link.to_string_lossy().into_owned();
    write_jsonl(
        &project_dir.join("foreign-secret.jsonl"),
        &[json!({
            "type": "user",
            "cwd": foreign_cwd_raw,
            "message": { "content": "foreign secret title" }
        })],
    )
    .await;

    let slot = active_slot(Some(&active));
    let home_path = home.path().to_path_buf();
    let result = sessions_list_via(&slot, active_raw, move |authorized| async move {
        std::fs::remove_file(&foreign_cwd_link).unwrap();
        symlink(&active, &foreign_cwd_link).unwrap();
        sessions_list_from_home(authorized, home_path).await
    })
    .await
    .unwrap();

    assert_eq!(result.len(), 1);
    assert_eq!(result[0].id, "active");
    assert_eq!(result[0].title, "active title");
}

/// Claude directory encodingが衝突しても、cwd欠落/空のforeign JSONLはproject所属を証明
/// できないためfail-closedでtitleを返さない。
#[tokio::test]
async fn sessions_list_missing_or_blank_cwd_collision_is_not_disclosed() {
    let sandbox = tempdir().unwrap();
    let active = sandbox.path().join("a-b");
    let foreign = sandbox.path().join("a").join("b");
    tokio::fs::create_dir_all(&active).await.unwrap();
    tokio::fs::create_dir_all(&foreign).await.unwrap();
    let active_raw = active.to_string_lossy().into_owned();
    let foreign_raw = foreign.to_string_lossy().into_owned();
    assert_eq!(
        encode_project_path(&active_raw),
        encode_project_path(&foreign_raw),
        "fixture must exercise an encoded Claude directory collision"
    );

    let home = tempdir().unwrap();
    let project_dir = home
        .path()
        .join(".claude/projects")
        .join(encode_project_path(&active_raw));
    tokio::fs::create_dir_all(&project_dir).await.unwrap();
    write_jsonl(
        &project_dir.join("active.jsonl"),
        &[json!({
            "type": "user",
            "cwd": active_raw,
            "message": { "content": "active title" }
        })],
    )
    .await;
    write_jsonl(
        &project_dir.join("foreign-missing-cwd.jsonl"),
        &[json!({
            "type": "user",
            "message": { "content": "foreign missing-cwd secret" }
        })],
    )
    .await;
    write_jsonl(
        &project_dir.join("foreign-blank-cwd.jsonl"),
        &[json!({
            "type": "user",
            "cwd": "  ",
            "message": { "content": "foreign blank-cwd secret" }
        })],
    )
    .await;

    let slot = active_slot(Some(&active));
    let result = sessions_list_via(&slot, active_raw, |authorized| {
        sessions_list_from_home(authorized, home.path().to_path_buf())
    })
    .await
    .unwrap();

    assert_eq!(result.len(), 1);
    assert_eq!(result[0].id, "active");
    assert_eq!(result[0].title, "active title");
}

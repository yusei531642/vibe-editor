//! Issue #494 / #837: `commands::sessions::read_jsonl_summary` の integration test。
//!
//! 本物の `~/.claude/projects/<encoded>/*.jsonl` を fixture として tempdir に作り、
//! title / cwd / message_count / capped の抽出が期待通り動くことを検証する。

use crate::commands::sessions::{
    read_jsonl_summary, sessions_list_from_home, sessions_list_via, SessionInfo,
};
use crate::pty::path_norm::encode_project_path;
use arc_swap::ArcSwapOption;
use serde_json::json;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tempfile::tempdir;

/// fixture jsonl を tempdir 配下に書き出すヘルパ。各 line は JSON object 1 件。
async fn write_jsonl(path: &PathBuf, lines: &[serde_json::Value]) {
    let body = lines
        .iter()
        .map(|v| serde_json::to_string(v).unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    tokio::fs::write(path, body).await.unwrap();
}

#[tokio::test]
async fn extracts_title_from_first_user_message_string_content() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("session-1.jsonl");
    write_jsonl(
        &path,
        &[
            json!({
                "type": "user",
                "cwd": "/home/user/proj",
                "message": { "content": "最初のユーザーメッセージ — これがタイトルになる" }
            }),
            json!({
                "type": "assistant",
                "message": { "content": "返事..." }
            }),
        ],
    )
    .await;

    let s = read_jsonl_summary(&path).await;
    assert!(s.title.starts_with("最初のユーザーメッセージ"));
    assert_eq!(s.message_count, 2);
    assert_eq!(s.cwd.as_deref(), Some("/home/user/proj"));
    assert!(!s.capped);
}

#[tokio::test]
async fn extracts_title_from_first_user_message_array_content() {
    // 新形式: message.content が `[{ type: "text", text: "..." }, ...]` の場合
    let dir = tempdir().unwrap();
    let path = dir.path().join("session-2.jsonl");
    write_jsonl(
        &path,
        &[json!({
            "type": "user",
            "cwd": "C:\\repo\\proj",
            "message": {
                "content": [
                    { "type": "text", "text": "Hello, can you check this?" }
                ]
            }
        })],
    )
    .await;

    let s = read_jsonl_summary(&path).await;
    assert_eq!(s.title, "Hello, can you check this?");
    assert_eq!(s.message_count, 1);
    assert_eq!(s.cwd.as_deref(), Some("C:\\repo\\proj"));
    assert!(!s.capped);
}

/// title が 1 行 80 文字で truncate されること。
#[tokio::test]
async fn title_truncates_to_first_line_80_chars() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("session-long.jsonl");
    let long = "あ".repeat(200); // 200 文字 (UTF-8 3 byte/char)
    write_jsonl(
        &path,
        &[json!({
            "type": "user",
            "cwd": "/x",
            "message": { "content": long }
        })],
    )
    .await;

    let s = read_jsonl_summary(&path).await;
    // chars().take(80) なので 80 文字までで止まる (バイト数ではなく char count)
    assert_eq!(s.title.chars().count(), 80);
    assert_eq!(s.title, "あ".repeat(80));
}

/// `\n` を含むメッセージは最初の行だけ title になる (改行で truncate)。
#[tokio::test]
async fn title_takes_first_line_only() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("session-multiline.jsonl");
    write_jsonl(
        &path,
        &[json!({
            "type": "user",
            "cwd": "/x",
            "message": { "content": "first line\nsecond line\nthird line" }
        })],
    )
    .await;

    let s = read_jsonl_summary(&path).await;
    assert_eq!(s.title, "first line");
}

/// 空行 / 不正 JSON 行は parse error 扱いで count に加算されない (空行) ようにする。
#[tokio::test]
async fn empty_lines_are_skipped_in_count() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("session-blank.jsonl");
    let body = format!(
        "\n\n{}\n\n{}\n",
        json!({"type": "user", "cwd": "/x", "message": {"content": "hi"}}),
        json!({"type": "assistant", "message": {"content": "hello"}})
    );
    tokio::fs::write(&path, body).await.unwrap();

    let s = read_jsonl_summary(&path).await;
    assert_eq!(s.title, "hi");
    assert_eq!(s.message_count, 2, "blank lines must not be counted");
    assert_eq!(s.cwd.as_deref(), Some("/x"));
}

/// 存在しないファイルは empty summary を返す (panic しない)。
#[tokio::test]
async fn missing_file_returns_empty_summary() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("nonexistent.jsonl");
    let s = read_jsonl_summary(&path).await;
    assert_eq!(s.title, "");
    assert_eq!(s.message_count, 0);
    assert!(s.cwd.is_none());
    assert!(!s.capped);
}

/// Issue #837: 会話メッセージ (type == "user" | "assistant") だけを数え、
/// summary / system / tool_result / file-history-snapshot 等は除外する。
#[tokio::test]
async fn only_user_and_assistant_lines_are_counted() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("session-mixed.jsonl");
    write_jsonl(
        &path,
        &[
            json!({ "type": "summary", "summary": "session summary" }),
            json!({ "type": "user", "cwd": "/x", "message": { "content": "q1" } }),
            json!({ "type": "assistant", "message": { "content": "a1" } }),
            json!({ "type": "system", "content": "system notice" }),
            json!({ "type": "tool_result", "content": "tool output" }),
            json!({ "type": "file-history-snapshot", "snapshot": {} }),
            json!({ "type": "user", "message": { "content": "q2" } }),
            json!({ "type": "assistant", "message": { "content": "a2" } }),
        ],
    )
    .await;

    let s = read_jsonl_summary(&path).await;
    // user 2 + assistant 2 = 4 (summary / system / tool_result / snapshot は除外)
    assert_eq!(
        s.message_count, 4,
        "only user/assistant messages must be counted"
    );
    assert_eq!(s.title, "q1");
    assert!(!s.capped);
}

/// PR #851 review (perf 対応): 会話メッセージ判定を substring 検索に変えても、
/// content 文字列内に `"type":"assistant"` 等のリテラルを含む行を二重カウントしない
/// (JSON エスケープにより未エスケープの並びはキー:値にしか出ないことの回帰ガード)。
#[tokio::test]
async fn content_containing_type_literal_is_not_double_counted() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("session-tricky.jsonl");
    write_jsonl(
        &path,
        &[
            // content にまぎらわしいリテラルを含む user メッセージ 1 件。
            json!({
                "type": "user",
                "cwd": "/x",
                "message": { "content": "JSON の {\"type\":\"assistant\"} について教えて" }
            }),
            json!({
                "type": "assistant",
                "message": { "content": "はい、それは {\"type\":\"user\"} とは別物です" }
            }),
        ],
    )
    .await;

    let s = read_jsonl_summary(&path).await;
    // user 1 + assistant 1 = 2。content 内のリテラルは数に影響しない。
    assert_eq!(
        s.message_count, 2,
        "literals inside content must not inflate the count"
    );
}

/// HEAD_LIMIT_LINES (= 2000) を超えるセッションは message_count が打ち切られ、capped=true。
/// 2500 行書いて count == 2000 / capped == true を確認する。
#[tokio::test]
async fn message_count_caps_at_head_limit() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("session-huge.jsonl");
    let mut lines: Vec<serde_json::Value> = Vec::with_capacity(2500);
    lines.push(json!({
        "type": "user",
        "cwd": "/x",
        "message": { "content": "title here" }
    }));
    for _ in 0..2499 {
        lines.push(json!({
            "type": "assistant",
            "message": { "content": "reply" }
        }));
    }
    write_jsonl(&path, &lines).await;

    let s = read_jsonl_summary(&path).await;
    assert_eq!(s.title, "title here");
    assert_eq!(s.message_count, 2000, "should cap at HEAD_LIMIT_LINES");
    assert!(s.capped, "exceeding the scan limit must set capped=true");
}

/// ちょうど HEAD_LIMIT_LINES 行のセッションは capped=false (= "N+" ではなく正確な値)。
#[tokio::test]
async fn exactly_head_limit_is_not_capped() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("session-exact.jsonl");
    let mut lines: Vec<serde_json::Value> = Vec::with_capacity(2000);
    lines.push(json!({
        "type": "user",
        "cwd": "/x",
        "message": { "content": "title here" }
    }));
    for _ in 0..1999 {
        lines.push(json!({
            "type": "assistant",
            "message": { "content": "reply" }
        }));
    }
    write_jsonl(&path, &lines).await;

    let s = read_jsonl_summary(&path).await;
    assert_eq!(s.message_count, 2000);
    assert!(
        !s.capped,
        "exactly HEAD_LIMIT_LINES messages must not be reported as capped"
    );
}

/// title / cwd が先頭 8 行内に無くても、count は最後まで (上限まで) カウントされる。
/// 旧 Issue #106 互換: 取れなくても break しない。Issue #837 に伴い fixture を
/// 会話メッセージ (assistant) に変更 (system は count 対象外になったため)。
#[tokio::test]
async fn missing_title_and_cwd_does_not_block_count() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("session-no-title.jsonl");
    let lines: Vec<serde_json::Value> = (0..50)
        .map(|i| {
            json!({
                "type": "assistant",
                "message": { "content": format!("assistant msg {i}") }
            })
        })
        .collect();
    write_jsonl(&path, &lines).await;

    let s = read_jsonl_summary(&path).await;
    // 先頭に user メッセージが無いので title は空・cwd も無し。
    assert_eq!(s.title, "");
    assert!(s.cwd.is_none());
    assert_eq!(s.message_count, 50);
    assert!(!s.capped);
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

/// Issue #1147 design review: canonical alias の requested raw を Claude directory key に
/// 使うと、cwd 欠落 JSONL の fail-open と組み合わさって別directoryのtitleを返せる。
/// gateと同じsnapshotの active rawだけをencodingに使うことをcanaryで固定する。
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
    // cwd欠落は既存filterがfail-openするため、requested alias側を読めば漏れるcanary。
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
/// foreign projectへ差し替えられない。directory keyだけはactive raw互換を維持し、
/// identity比較はgate時canonical snapshotへ固定する。
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
    let project_dir = home
        .path()
        .join(".claude/projects")
        .join(encode_project_path(&active_raw));
    tokio::fs::create_dir_all(&project_dir).await.unwrap();
    write_jsonl(
        &project_dir.join("active.jsonl"),
        &[json!({
            "type": "user",
            "cwd": active.to_string_lossy(),
            "message": { "content": "active title" }
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

    assert_eq!(result.len(), 1);
    assert_eq!(result[0].id, "active");
}

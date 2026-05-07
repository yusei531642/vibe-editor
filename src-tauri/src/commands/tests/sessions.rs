//! Issue #494: `commands::sessions::read_jsonl_summary` の integration test。
//!
//! 本物の `~/.claude/projects/<encoded>/*.jsonl` を fixture として tempdir に作り、
//! title / cwd / message_count の抽出が期待通り動くことを検証する。

use crate::commands::sessions::read_jsonl_summary;
use serde_json::json;
use std::path::PathBuf;
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

    let (title, count, cwd) = read_jsonl_summary(&path).await;
    assert!(title.starts_with("最初のユーザーメッセージ"));
    assert_eq!(count, 2);
    assert_eq!(cwd.as_deref(), Some("/home/user/proj"));
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

    let (title, count, cwd) = read_jsonl_summary(&path).await;
    assert_eq!(title, "Hello, can you check this?");
    assert_eq!(count, 1);
    assert_eq!(cwd.as_deref(), Some("C:\\repo\\proj"));
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

    let (title, _count, _cwd) = read_jsonl_summary(&path).await;
    // chars().take(80) なので 80 文字までで止まる (バイト数ではなく char count)
    assert_eq!(title.chars().count(), 80);
    assert_eq!(title, "あ".repeat(80));
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

    let (title, _count, _cwd) = read_jsonl_summary(&path).await;
    assert_eq!(title, "first line");
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

    let (title, count, cwd) = read_jsonl_summary(&path).await;
    assert_eq!(title, "hi");
    assert_eq!(count, 2, "blank lines must not be counted");
    assert_eq!(cwd.as_deref(), Some("/x"));
}

/// 存在しないファイルは empty triple を返す (panic しない)。
#[tokio::test]
async fn missing_file_returns_empty_triple() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("nonexistent.jsonl");
    let (title, count, cwd) = read_jsonl_summary(&path).await;
    assert_eq!(title, "");
    assert_eq!(count, 0);
    assert!(cwd.is_none());
}

/// HEAD_LIMIT_LINES (= 2000) で count が打ち切られる。
/// 2500 行書いて count == 2000 を確認する。
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

    let (title, count, _cwd) = read_jsonl_summary(&path).await;
    assert_eq!(title, "title here");
    assert_eq!(count, 2000, "should cap at HEAD_LIMIT_LINES");
}

/// title / cwd が先頭 8 行内に無くても、count は最後まで (上限まで) カウントされる。
/// 旧 Issue #106 互換: 取れなくても break しない。
#[tokio::test]
async fn missing_title_and_cwd_does_not_block_count() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("session-no-title.jsonl");
    let lines: Vec<serde_json::Value> = (0..50)
        .map(|i| {
            json!({
                "type": "system",
                "message": { "content": format!("system msg {i}") }
            })
        })
        .collect();
    write_jsonl(&path, &lines).await;

    let (title, count, cwd) = read_jsonl_summary(&path).await;
    assert_eq!(title, "");
    assert!(cwd.is_none());
    assert_eq!(count, 50);
}

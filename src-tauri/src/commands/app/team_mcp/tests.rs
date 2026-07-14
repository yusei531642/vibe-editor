//! Issue #597: claude / codex の片肺 rollback を防止する 2-phase シーケンスのテスト。
//!
//! `app_setup_team_mcp` 自体は `tauri::State` に依存して unit test しづらいので、
//! 実体である `run_setup_at` / `run_cleanup_at` を path 引数で叩いて検証する。
//! 共通の `rollback_both` を使うので、setup の rollback 経路で symmetry が証明できれば
//! cleanup の rollback も同等に動く (cleanup の失敗注入は OS 依存性が高く不安定なため省略)。

use super::*;
use serde_json::json;
use tempfile::TempDir;
use tokio::fs;

/// codex 側 setup を強制失敗させたとき、claude 側も snapshot 状態に戻ること。
///
/// 失敗の作り方: codex_path の親を「regular file」として配置 → atomic_write 内の
/// `create_dir_all(parent)` が ENOTDIR / AlreadyExists 系で失敗する (POSIX/Windows 共通)。
/// これは Issue #597 の修正前は claude::restore だけが走り codex 側の半端書き残存を
/// 招いていた経路。修正後は claude 側も巻き戻る。
#[tokio::test]
async fn setup_rolls_back_both_when_codex_setup_fails() {
    let tmp = TempDir::new().unwrap();
    let claude_path = tmp.path().join(".claude.json");
    // 既存 claude content を仕込む (rollback 後にこれが残ることを検証)
    let original_claude = br#"{"existing":true}"#.to_vec();
    fs::write(&claude_path, &original_claude).await.unwrap();

    // codex_path の親を「ファイル」にして codex::setup_at の create_dir_all を確実に失敗させる
    let blocker = tmp.path().join("blocker");
    fs::write(&blocker, b"this is a file, not a directory")
        .await
        .unwrap();
    let codex_path = blocker.join("config.toml");

    let desired = json!({
        "type": "stdio",
        "command": "node",
        "args": ["/tmp/bridge.js"]
    });

    let res = run_setup_at(&claude_path, &codex_path, &desired, "/tmp/bridge.js").await;
    assert!(
        res.is_err(),
        "codex setup should fail when parent is a file"
    );
    let msg = format!("{:#}", res.unwrap_err());
    assert!(
        msg.contains("codex mcp setup"),
        "error should mention codex mcp setup, got: {msg}"
    );

    // claude 側が rollback されているか確認
    let after = fs::read(&claude_path).await.unwrap();
    assert_eq!(
        after, original_claude,
        "claude must be rolled back to original bytes"
    );
    // codex 側はそもそも書けなかったので存在しないこと
    assert!(
        !codex_path.exists(),
        "codex file should not exist after failed setup"
    );
}

#[tokio::test]
async fn setup_rolls_back_both_when_codex_config_is_not_utf8() {
    let tmp = TempDir::new().unwrap();
    let claude_path = tmp.path().join(".claude.json");
    let original_claude = br#"{"mcpServers":{"other":{"command":"node"}}}"#.to_vec();
    fs::write(&claude_path, &original_claude).await.unwrap();

    let codex_path = tmp.path().join(".codex").join("config.toml");
    fs::create_dir_all(codex_path.parent().unwrap())
        .await
        .unwrap();
    let original_codex = b"[other]\n# invalid utf8: \x82\xa0\n".to_vec();
    fs::write(&codex_path, &original_codex).await.unwrap();

    let desired = json!({
        "type": "stdio",
        "command": "node",
        "args": ["/tmp/bridge.js"]
    });

    let res = run_setup_at(&claude_path, &codex_path, &desired, "/tmp/bridge.js").await;

    assert!(res.is_err(), "codex setup should reject non-UTF-8 config");
    let msg = format!("{:#}", res.unwrap_err());
    assert!(
        msg.contains("codex mcp setup"),
        "error should mention codex mcp setup, got: {msg}"
    );
    assert!(
        msg.contains("not valid UTF-8"),
        "error should mention UTF-8 decode failure, got: {msg}"
    );
    let claude_after = fs::read(&claude_path).await.unwrap();
    assert_eq!(
        claude_after, original_claude,
        "claude must be rolled back after codex decode failure"
    );
    let codex_after = fs::read(&codex_path).await.unwrap();
    assert_eq!(
        codex_after, original_codex,
        "codex invalid bytes must be preserved for manual repair"
    );
}

/// claude 側 setup を強制失敗 (root が array → object check で Err) させたとき、
/// codex 側の事前 snapshot も restore されること。
#[tokio::test]
async fn setup_rolls_back_both_when_claude_setup_fails() {
    let tmp = TempDir::new().unwrap();
    let claude_path = tmp.path().join(".claude.json");
    // claude::setup_at は root が JSON array だと「~/.claude.json must be an object」で Err。
    fs::write(&claude_path, b"[]").await.unwrap();

    let codex_path = tmp.path().join(".codex").join("config.toml");
    // codex に既存 content を入れて、rollback で元に戻ることを検証
    let original_codex = b"[other]\nfoo = 1\n".to_vec();
    fs::create_dir_all(codex_path.parent().unwrap())
        .await
        .unwrap();
    fs::write(&codex_path, &original_codex).await.unwrap();

    let desired = json!({ "type": "stdio" });
    let res = run_setup_at(&claude_path, &codex_path, &desired, "/tmp/bridge.js").await;
    assert!(res.is_err(), "claude setup should fail with array root");
    let msg = format!("{:#}", res.unwrap_err());
    assert!(
        msg.contains("claude mcp setup"),
        "error should mention claude mcp setup, got: {msg}"
    );

    // claude は元のまま (array)
    let claude_after = fs::read(&claude_path).await.unwrap();
    assert_eq!(claude_after, b"[]");
    // codex も rollback で original_codex のまま (claude 失敗時でも codex 側 snapshot は restore される)
    let codex_after = fs::read(&codex_path).await.unwrap();
    assert_eq!(
        codex_after, original_codex,
        "codex must be unchanged / rolled back even when claude side fails first"
    );
}

/// 正常系: 両方 setup 成功 → claude には mcpServers.vibe-team が、
/// codex には [mcp_servers.vibe-team] が入る。
#[tokio::test]
async fn setup_writes_both_when_no_failure() {
    let tmp = TempDir::new().unwrap();
    let claude_path = tmp.path().join(".claude.json");
    let codex_path = tmp.path().join(".codex").join("config.toml");

    let desired = json!({
        "type": "stdio",
        "command": "node",
        "args": ["/tmp/bridge.js"]
    });

    let changed = run_setup_at(&claude_path, &codex_path, &desired, "/tmp/bridge.js")
        .await
        .unwrap();
    assert!(changed, "first setup should report changed=true");

    let claude_str = fs::read_to_string(&claude_path).await.unwrap();
    assert!(
        claude_str.contains("vibe-team"),
        "claude should contain vibe-team entry"
    );
    let codex_str = fs::read_to_string(&codex_path).await.unwrap();
    assert!(
        codex_str.contains("[mcp_servers.vibe-team]"),
        "codex should contain section"
    );
}

/// cleanup 正常系: claude / codex 両方から vibe-team 行が消える。
#[tokio::test]
async fn cleanup_removes_from_both() {
    let tmp = TempDir::new().unwrap();
    let claude_path = tmp.path().join(".claude.json");
    let original_claude = br#"{
  "mcpServers": {
"vibe-team": { "command": "node" }
  }
}"#
    .to_vec();
    fs::write(&claude_path, &original_claude).await.unwrap();

    let codex_path = tmp.path().join(".codex").join("config.toml");
    let original_codex =
        b"[other]\nfoo = 1\n\n[mcp_servers.vibe-team]\ncommand = \"node\"\n".to_vec();
    fs::create_dir_all(codex_path.parent().unwrap())
        .await
        .unwrap();
    fs::write(&codex_path, &original_codex).await.unwrap();

    let removed = run_cleanup_at(&claude_path, &codex_path).await.unwrap();
    assert!(
        removed,
        "cleanup should report removed=true when claude had vibe-team entry"
    );

    let claude_after = fs::read_to_string(&claude_path).await.unwrap();
    assert!(
        !claude_after.contains("vibe-team"),
        "claude vibe-team entry should be gone"
    );
    let codex_after = fs::read_to_string(&codex_path).await.unwrap();
    assert!(
        !codex_after.contains("[mcp_servers.vibe-team]"),
        "codex section should be gone"
    );
    assert!(
        codex_after.contains("[other]"),
        "codex other sections must be preserved"
    );
}

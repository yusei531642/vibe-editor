//! Issue #494: `commands::settings` の integration test。
//!
//! Phase 2 (PR #501 / Issue #493) で `Settings` を strong-typed serde struct 化したので、
//! ここでは `Settings` ⇔ disk JSON ⇔ atomic_write の round-trip を tempdir 配下で走らせる。
//! `settings_load` / `settings_save` は内部で `~/.vibe-editor/settings.json` を直接さわる
//! Tauri command なので、env (USERPROFILE / HOME) 操作はせず代わりに Settings 単体の
//! roundtrip + atomic_write の組み合わせで cover する。

use crate::commands::atomic_write::atomic_write;
use crate::commands::settings::{AgentConfig, Settings, APP_SETTINGS_SCHEMA_VERSION};
use serde_json::json;
use tempfile::tempdir;

/// `Settings::default()` を JSON にして atomic_write し、読み戻して deserialize できる。
/// renderer 側 `migrateSettings` が見る wire shape が壊れないことを担保する。
#[tokio::test]
async fn default_settings_roundtrip_through_atomic_write() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("settings.json");

    // save
    let settings = Settings::default();
    let json = serde_json::to_vec_pretty(&settings).unwrap();
    atomic_write(&path, &json).await.unwrap();

    // load
    let bytes = tokio::fs::read(&path).await.unwrap();
    let loaded: Settings = serde_json::from_slice(&bytes).unwrap();

    // 主要フィールドが round-trip 後も同値
    assert_eq!(loaded.schema_version, Some(APP_SETTINGS_SCHEMA_VERSION));
    assert_eq!(loaded.language, "ja");
    assert_eq!(loaded.theme, "claude-dark");
    assert_eq!(loaded.density, "normal");
    assert_eq!(loaded.claude_command, "claude");
    assert_eq!(loaded.codex_command, "codex");
    assert_eq!(loaded.ui_font_size, 14.0);
    assert_eq!(loaded.editor_font_size, 13.0);
    assert_eq!(loaded.terminal_font_size, 13.0);
    assert_eq!(loaded.sidebar_width, 272.0);
    assert_eq!(loaded.claude_code_panel_width, 460.0);
    assert_eq!(loaded.has_completed_onboarding, Some(false));
    assert_eq!(loaded.mcp_auto_setup, Some(true));
}

/// 旧バージョン (schemaVersion=2) の minimal JSON を保存 → load しても deserialize 可能。
/// renderer 側の `migrateSettings` が schemaVersion を見て v2→v10 migration を回す前提。
#[tokio::test]
async fn legacy_v2_json_loads_and_default_fills_missing_fields() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("settings.json");

    let legacy = json!({
        "schemaVersion": 2,
        "language": "en",
        "theme": "dark",
        "uiFontFamily": "Arial",
        "uiFontSize": 12,
        "editorFontFamily": "Consolas",
        "editorFontSize": 11,
        "terminalFontSize": 11,
        "density": "compact",
        "claudeCommand": "claude",
        "claudeArgs": "",
        "claudeCwd": "/home/user/proj",
        "lastOpenedRoot": "/home/user/proj",
        "recentProjects": ["/home/user/proj"],
        "workspaceFolders": [],
        "claudeCodePanelWidth": 400,
        "sidebarWidth": 250,
        "codexCommand": "codex",
        "codexArgs": "",
        "notepad": ""
        // hasCompletedOnboarding / customAgents / mcpAutoSetup / fileTreeExpanded は未追加 (= v2 時代)
    });
    let bytes = serde_json::to_vec(&legacy).unwrap();
    atomic_write(&path, &bytes).await.unwrap();

    let raw = tokio::fs::read(&path).await.unwrap();
    let loaded: Settings = serde_json::from_slice(&raw).unwrap();

    assert_eq!(loaded.schema_version, Some(2));
    assert_eq!(loaded.language, "en");
    assert_eq!(loaded.theme, "dark");
    assert_eq!(loaded.claude_cwd, "/home/user/proj");
    assert_eq!(loaded.recent_projects, vec!["/home/user/proj".to_string()]);
    // missing optional は None / default
    assert!(loaded.has_completed_onboarding.is_none());
    assert!(loaded.custom_agents.is_none());
    assert!(loaded.mcp_auto_setup.is_none());
    assert!(loaded.file_tree_expanded.is_none());
}

/// 不正な型 (`claudeArgs: 12345` = number) は deserialize で reject。
/// renderer 側 `invoke('settings_save', { settings: bad })` が Promise reject になる経路の根拠。
#[tokio::test]
async fn invalid_claude_args_type_rejected_on_load() {
    let bad = json!({
        "language": "ja",
        "claudeArgs": 12345
    });
    let res: Result<Settings, _> = serde_json::from_value(bad);
    assert!(res.is_err(), "claudeArgs as number must reject");
}

/// `customAgents` の各エントリの `cwd` / `color` は optional。両方欠けても deserialize できる。
#[tokio::test]
async fn agent_config_minimal_entry_loads() {
    let raw = json!({
        "customAgents": [
            { "id": "x", "name": "X", "command": "x", "args": "" }
        ]
    });
    let loaded: Settings = serde_json::from_value(raw).unwrap();
    let agents = loaded.custom_agents.unwrap();
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0].id, "x");
    assert!(agents[0].cwd.is_none());
    assert!(agents[0].color.is_none());
}

/// `customAgents` の `cwd` / `color` 完備バージョンも round-trip 可能。
#[tokio::test]
async fn agent_config_full_entry_round_trips() {
    let mut s = Settings::default();
    s.custom_agents = Some(vec![AgentConfig {
        id: "claude-dev".into(),
        name: "Claude (dev)".into(),
        command: "claude".into(),
        args: "--debug".into(),
        cwd: Some("/tmp".into()),
        color: Some("#ff0000".into()),
    }]);

    let bytes = serde_json::to_vec(&s).unwrap();
    let back: Settings = serde_json::from_slice(&bytes).unwrap();
    let agents = back.custom_agents.unwrap();
    assert_eq!(agents[0].id, "claude-dev");
    assert_eq!(agents[0].name, "Claude (dev)");
    assert_eq!(agents[0].args, "--debug");
    assert_eq!(agents[0].cwd.as_deref(), Some("/tmp"));
    assert_eq!(agents[0].color.as_deref(), Some("#ff0000"));
}

/// 未知フィールドは silent に drop される (forward-compat 寄り)。renderer 側で
/// 拡張 field を先に追加 → Rust 側はまだ知らないという過渡期も deserialize は成功させる。
#[tokio::test]
async fn unknown_fields_are_silently_dropped() {
    let raw = json!({
        "language": "ja",
        "theme": "claude-dark",
        "futureField": "future-value",
        "anotherUnknown": [1, 2, 3]
    });
    let loaded: Settings = serde_json::from_value(raw).unwrap();
    assert_eq!(loaded.language, "ja");
    assert_eq!(loaded.theme, "claude-dark");
    // re-serialize したときに drop されている
    let back = serde_json::to_value(&loaded).unwrap();
    assert!(back.get("futureField").is_none());
    assert!(back.get("anotherUnknown").is_none());
}

/// 並列に多数 atomic_write → 最終 read で valid JSON で読める (atomic 性の sanity check)。
/// `commands/atomic_write.rs::tests` で個別カバー済みだが、Settings shape との組み合わせを
/// integration として一回回しておく。
#[tokio::test]
async fn concurrent_atomic_writes_leave_valid_settings_json() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("settings.json");

    let mut handles = Vec::new();
    for i in 0..16 {
        let path_clone = path.clone();
        handles.push(tokio::spawn(async move {
            let mut s = Settings::default();
            s.notepad = format!("write-{i}");
            s.ui_font_size = 14.0 + (i as f64);
            let json = serde_json::to_vec_pretty(&s).unwrap();
            atomic_write(&path_clone, &json).await.unwrap();
        }));
    }
    for h in handles {
        h.await.unwrap();
    }

    // 最後に書かれた内容が valid Settings として deserialize できる
    let bytes = tokio::fs::read(&path).await.unwrap();
    let loaded: Settings = serde_json::from_slice(&bytes).unwrap();
    assert!(loaded.notepad.starts_with("write-"));
    assert!(loaded.ui_font_size >= 14.0);
}

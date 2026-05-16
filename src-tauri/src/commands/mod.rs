// Tauri command 群
//
// 既存 src/main/ipc/*.ts と 1:1 対応。
// camelCase JSON 互換のため、各 command struct/enum には #[serde(rename_all = "camelCase")] を付与する。

pub mod app;
// Issue #724 (Security): `asset://` protocol scope の動的許可ヘルパー。
pub mod asset_scope;
pub mod atomic_write;
pub mod authz;
pub mod dialog;
pub mod error;
pub mod files;
pub mod fs_watch;
pub mod git;
pub mod handoffs;
pub mod logs;
pub mod role_profiles;
// Issue #739: 永続化 schema バージョン定数 + 互換性ガードの集約モジュール。
pub mod schema_version;
pub mod sessions;
pub mod settings;
pub mod team_diagnostics;
pub mod team_history;
pub mod team_inject;
pub mod team_presets;
pub mod team_state;
pub mod terminal;
pub mod terminal_tabs;
// Issue #624 (Security): IPC 入力検証 (id segment / size cap / log sanitize) の共通 helper。
pub mod validation;
pub mod vibe_team_skill;

/// Issue #494: `commands/*.rs` の integration test を集約する test-only module。
/// Phase 1/2 で固まった IPC 境界 (settings load/save / git status/diff / sessions list /
/// atomic_write) を tempdir + fixture で end-to-end に走らせる。
#[cfg(test)]
mod tests;

#[tauri::command]
pub fn ping() -> &'static str {
    "pong"
}

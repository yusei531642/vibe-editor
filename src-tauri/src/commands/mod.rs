// Tauri command 群
//
// 既存 src/main/ipc/*.ts と 1:1 対応。
// camelCase JSON 互換のため、各 command struct/enum には #[serde(rename_all = "camelCase")] を付与する。

pub mod app;
pub mod atomic_write;
pub mod dialog;
pub mod error;
pub mod files;
pub mod fs_watch;
pub mod git;
pub mod handoffs;
pub mod logs;
pub mod role_profiles;
pub mod sessions;
pub mod settings;
pub mod team_history;
pub mod team_state;
pub mod terminal;
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

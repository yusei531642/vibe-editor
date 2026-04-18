// Tauri command 群
//
// 既存 src/main/ipc/*.ts と 1:1 対応。
// camelCase JSON 互換のため、各 command struct/enum には #[serde(rename_all = "camelCase")] を付与する。

pub mod app;
pub mod atomic_write;
pub mod dialog;
pub mod files;
pub mod fs_watch;
pub mod git;
pub mod sessions;
pub mod settings;
pub mod team_history;
pub mod terminal;

#[tauri::command]
pub fn ping() -> &'static str {
    "pong"
}

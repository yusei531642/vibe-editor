// vibe-editor Tauri main entry point
//
// Phase 1 シェル移行版。実 IPC 実装は順次 commands/*.rs に追加していく。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    vibe_editor_lib::run();
}

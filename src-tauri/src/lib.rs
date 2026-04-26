// vibe-editor Tauri library entry
//
// Phase 1: Tauri shell + 8 IPC モジュール
// 各 commands/*.rs は IPC 契約 (src/types/ipc.ts) に合わせた #[tauri::command] を提供する。
// PTY backend (portable-pty + batcher) は src/pty/ に集約。

mod commands;
mod mcp_config;
mod pty;
mod state;
mod team_hub;

use tauri::Manager;
#[allow(unused_imports)]
use tracing::info;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "vibe_editor_lib=debug,info".into()),
        )
        .init();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            info!("Second instance attempted. args={args:?}");
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
                let _ = win.unminimize();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(state::AppState::new())
        .invoke_handler(tauri::generate_handler![
            // ---- root ----
            commands::ping,
            // ---- app ----
            commands::app::app_get_project_root,
            commands::app::app_set_project_root,
            commands::app::app_restart,
            commands::app::app_set_window_title,
            commands::app::app_check_claude,
            commands::app::app_set_zoom_level,
            commands::app::app_setup_team_mcp,
            commands::app::app_cleanup_team_mcp,
            commands::app::app_get_team_file_path,
            commands::app::app_get_mcp_server_path,
            commands::app::app_get_team_hub_info,
            commands::app::app_set_role_profile_summary,
            commands::app::app_cancel_recruit,
            commands::app::app_get_user_info,
            commands::app::app_open_external,
            // ---- git ----
            commands::git::git_status,
            commands::git::git_diff,
            // ---- files ----
            commands::files::files_list,
            commands::files::files_read,
            commands::files::files_write,
            // ---- sessions ----
            commands::sessions::sessions_list,
            // ---- team_history ----
            commands::team_history::team_history_list,
            commands::team_history::team_history_save,
            commands::team_history::team_history_save_batch,
            commands::team_history::team_history_delete,
            // ---- dialog ----
            commands::dialog::dialog_open_folder,
            commands::dialog::dialog_open_file,
            commands::dialog::dialog_is_folder_empty,
            // ---- settings ----
            commands::settings::settings_load,
            commands::settings::settings_save,
            // ---- role profiles ----
            commands::role_profiles::role_profiles_load,
            commands::role_profiles::role_profiles_save,
            // ---- terminal ----
            commands::terminal::terminal_create,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_kill,
            commands::terminal::terminal_save_pasted_image,
            // ---- vibe-team Skill ----
            commands::vibe_team_skill::app_install_vibe_team_skill,
        ])
        .setup(|app| {
            info!(
                "vibe-editor (Tauri) v{} starting",
                app.package_info().version
            );
            // TeamHub は app start で常時稼働
            let state = app.state::<state::AppState>();
            let hub = state.team_hub.clone();
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                hub.set_app_handle(app_handle).await;
                if let Err(e) = hub.start().await {
                    tracing::warn!("teamhub start failed: {e:#}");
                }
            });

            // Issue #29: settings.json の lastOpenedRoot から AppState.project_root を復元する。
            // renderer がロードされる前に watcher / app_get_project_root が呼ばれても、
            // 正しい project root を返せるようにするためここで先読みする。
            let app_handle_for_root = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let settings = commands::settings::settings_load().await;
                let root = settings
                    .get("lastOpenedRoot")
                    .and_then(|v| v.as_str())
                    .map(str::to_owned)
                    .filter(|s| !s.trim().is_empty())
                    .or_else(|| {
                        settings
                            .get("claudeCwd")
                            .and_then(|v| v.as_str())
                            .map(str::to_owned)
                            .filter(|s| !s.trim().is_empty())
                    });
                if let Some(root) = root {
                    let state = app_handle_for_root.state::<state::AppState>();
                    let lock_result = state.project_root.lock();
                    if let Ok(mut guard) = lock_result {
                        *guard = Some(root.clone());
                        tracing::info!("[setup] project_root restored from settings: {root}");
                    }
                }
            });
            #[cfg(debug_assertions)]
            {
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                }
            }

            // Issue #55: メイン window の CloseRequested で PTY と TeamHub を明示 cleanup する。
            // portable-pty (Windows ConPTY) は親が落ちても子が残る場合があるので、
            // 明示的に kill_all を呼んで Claude / Codex プロセスが孤立しないようにする。
            if let Some(main_window) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                main_window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { .. } = event {
                        tracing::info!("[lifecycle] window close — running cleanup");
                        let state = app_handle.state::<state::AppState>();
                        state.pty_registry.kill_all();
                        // MCP エントリは残しておく (次回起動時に reclaim されるので副作用なし)
                        // team-bridge.js は ~/.vibe-editor/ に置いたまま (再利用のため)
                    }
                });
            }
            Ok(())
        });

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

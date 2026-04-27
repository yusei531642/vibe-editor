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
mod util;

use std::fs::OpenOptions;
use std::io::{self, Write};
use std::sync::{Arc, Mutex as StdMutex};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;
#[allow(unused_imports)]
use tracing::info;
use tracing_subscriber::fmt::writer::MakeWriter;
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

#[derive(Clone)]
struct FileLogWriter {
    file: Arc<StdMutex<Option<std::fs::File>>>,
}

struct FileLogGuard {
    file: Arc<StdMutex<Option<std::fs::File>>>,
}

impl<'a> MakeWriter<'a> for FileLogWriter {
    type Writer = FileLogGuard;

    fn make_writer(&'a self) -> Self::Writer {
        FileLogGuard {
            file: self.file.clone(),
        }
    }
}

impl Write for FileLogGuard {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if let Ok(mut guard) = self.file.lock() {
            if let Some(file) = guard.as_mut() {
                file.write_all(buf)?;
            }
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        if let Ok(mut guard) = self.file.lock() {
            if let Some(file) = guard.as_mut() {
                file.flush()?;
            }
        }
        Ok(())
    }
}

fn init_logging() {
    let filter = EnvFilter::try_new(
        std::env::var("RUST_LOG").unwrap_or_else(|_| "vibe_editor_lib=debug,info".into()),
    )
    .unwrap_or_else(|_| EnvFilter::new("info"));
    let log_path = util::app_log::log_path();
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .ok();

    let console_layer = fmt::layer();
    let file_layer = fmt::layer()
        .with_ansi(false)
        .with_writer(FileLogWriter {
            file: Arc::new(StdMutex::new(log_file)),
        });

    tracing_subscriber::registry()
        .with(filter)
        .with(console_layer)
        .with(file_layer)
        .init();

    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        tracing::error!("[panic] {panic_info}");
        default_hook(panic_info);
    }));
}

/// Issue: × で閉じたときの挙動を settings.json から sync に読む。
/// CloseRequested ハンドラは sync コンテキストなので tokio::fs を使う非同期版
/// settings_load を待てない。close behavior は close 時に都度読めば足りる
/// (頻度が低いので blocking I/O の影響は無視できる)。
/// 値は "tray" (デフォルト) または "quit"。
fn read_close_behavior() -> String {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return "tray".to_string(),
    };
    let path = home.join(".vibe-editor").join("settings.json");
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return "tray".to_string(),
    };
    let v: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => return "tray".to_string(),
    };
    v.get("closeBehavior")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "tray".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_logging();

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
            commands::app::app_quit,
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
            commands::app::app_reveal_path,
            commands::app::app_get_log_info,
            commands::app::app_clear_log,
            commands::app::app_append_renderer_log,
            // ---- git ----
            commands::git::git_status,
            commands::git::git_diff,
            // ---- files ----
            commands::files::files_list,
            commands::files::files_read,
            commands::files::files_write,
            // ---- sessions ----
            commands::sessions::sessions_list,
            commands::sessions::session_exists,
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
            // Issue #155: spawn したタスクが panic で silent に死ぬのを防ぐため、
            // tokio::task::spawn の JoinHandle を観察するラッパーを介して spawn する。
            // panic は JoinError::is_panic() で検出して error ログに残す。
            fn spawn_observed<F>(name: &'static str, fut: F)
            where
                F: std::future::Future<Output = ()> + Send + 'static,
            {
                tauri::async_runtime::spawn(async move {
                    let join = tokio::task::spawn(fut);
                    match join.await {
                        Ok(()) => {}
                        Err(je) if je.is_panic() => {
                            let payload = je.into_panic();
                            let msg = payload
                                .downcast_ref::<String>()
                                .cloned()
                                .or_else(|| {
                                    payload
                                        .downcast_ref::<&'static str>()
                                        .map(|s| s.to_string())
                                })
                                .unwrap_or_else(|| "(unknown)".to_string());
                            tracing::error!("[setup] {name} task panicked: {msg}");
                        }
                        Err(je) => {
                            tracing::error!("[setup] {name} task join error: {je}");
                        }
                    }
                });
            }

            // TeamHub は app start で常時稼働
            let state = app.state::<state::AppState>();
            let hub = state.team_hub.clone();
            let app_handle = app.handle().clone();
            spawn_observed("teamhub", async move {
                hub.set_app_handle(app_handle).await;
                if let Err(e) = hub.start().await {
                    tracing::warn!("teamhub start failed: {e:#}");
                }
            });

            // Issue #29: settings.json の lastOpenedRoot から AppState.project_root を復元する。
            let app_handle_for_root = app.handle().clone();
            spawn_observed("settings_restore", async move {
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
                    // Issue #147: poison でも recovery
                    let mut guard = state::lock_project_root_recover(&state.project_root);
                    *guard = Some(root.clone());
                    tracing::info!("[setup] project_root restored from settings: {root}");
                }
            });
            #[cfg(debug_assertions)]
            {
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                }
            }

            // Issue: × で閉じても Team の PTY を生かしたまま「トレイに常駐」する。
            //   - settings.closeBehavior == "tray" (デフォルト): prevent_close + window.hide()
            //   - settings.closeBehavior == "quit"            : 旧挙動 (kill_all して exit)
            // Issue #55: portable-pty (Windows ConPTY) は親が落ちても子が残る場合があるので、
            //   "quit" 経路で明示的に kill_all を呼んで Claude / Codex プロセスが孤立しないようにする。
            //   "tray" 経路では PTY をそのまま走らせ続けることが目的なので kill しない。
            if let Some(main_window) = app.get_webview_window("main") {
                let app_handle_close = app.handle().clone();
                main_window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        let behavior = read_close_behavior();
                        if behavior == "quit" {
                            tracing::info!("[lifecycle] window close (quit) — kill_all + exit");
                            let state = app_handle_close.state::<state::AppState>();
                            state.pty_registry.kill_all();
                            // close を許可 (api.prevent_close を呼ばない) → 続けて app exit
                        } else {
                            tracing::info!("[lifecycle] window close — minimize to tray");
                            api.prevent_close();
                            if let Some(w) = app_handle_close.get_webview_window("main") {
                                let _ = w.hide();
                            }
                        }
                    }
                });
            }

            // Issue: システムトレイ (Show / Quit メニュー + 左クリックでウィンドウ復元)。
            // tauri.conf.json の trayIcon は最小設定 (icon + tooltip) のみ。メニュー / イベントは
            // ここで構築する。default_window_icon を流用してアイコンの二重バンドルを避ける。
            let show_item = MenuItemBuilder::with_id("show", "Show vibe-editor").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit vibe-editor").build(app)?;
            let tray_menu = MenuBuilder::new(app)
                .items(&[&show_item, &quit_item])
                .build()?;
            let mut tray_builder = TrayIconBuilder::with_id("main")
                .tooltip("vibe-editor")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => {
                        tracing::info!("[lifecycle] tray quit — kill_all + exit");
                        let state = app.state::<state::AppState>();
                        state.pty_registry.kill_all();
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                });
            if let Some(icon) = app.default_window_icon().cloned() {
                tray_builder = tray_builder.icon(icon);
            }
            if let Err(e) = tray_builder.build(app) {
                tracing::warn!("[tray] failed to build tray icon: {e:#}");
            }
            Ok(())
        });

    // Issue #155: builder.run().expect だと plugin 初期化失敗 / single_instance bind 失敗 /
    // setup 内 panic がすべて同じメッセージで死に、ユーザー報告から原因究明できない。
    // Err を構造化ログしてから exit code 1 で抜ける。
    if let Err(e) = builder.run(tauri::generate_context!()) {
        tracing::error!("[startup] tauri builder failed: {e:#}");
        eprintln!("vibe-editor failed to start: {e:#}");
        std::process::exit(1);
    }
}

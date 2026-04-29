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

use tauri::Manager;
#[allow(unused_imports)]
use tracing::info;

/// Issue #326: tracing を stderr + ファイル両方に書き出す。
/// ファイルは `~/.vibe-editor/logs/vibe-editor.log` (1 ファイル無回転、tracing-appender::never)。
/// 設定モーダルからこのファイルを読み返してエラーログを GUI 上で確認できる。
fn init_logging() {
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    use tracing_subscriber::{fmt, EnvFilter};

    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("vibe_editor_lib=debug,info"));

    let log_dir = commands::logs::log_dir();
    let _ = std::fs::create_dir_all(&log_dir); // best-effort
    let file_appender = tracing_appender::rolling::never(log_dir, "vibe-editor.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
    // WorkerGuard はプロセス終了まで保持する必要があるため leak で 'static 化する。
    // 1 度だけの起動コストで、メモリリークも 1 件のみ (許容)。
    Box::leak(Box::new(guard));

    let stderr_layer = fmt::layer().with_writer(std::io::stderr);
    let file_layer = fmt::layer().with_writer(non_blocking).with_ansi(false);

    tracing_subscriber::registry()
        .with(env_filter)
        .with(stderr_layer)
        .with(file_layer)
        .init();
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
            commands::app::app_set_window_title,
            commands::app::app_check_claude,
            commands::app::app_set_zoom_level,
            commands::app::app_set_window_effects,
            commands::app::app_setup_team_mcp,
            commands::app::app_cleanup_team_mcp,
            commands::app::app_get_team_file_path,
            commands::app::app_get_mcp_server_path,
            commands::app::app_get_team_hub_info,
            commands::app::app_set_role_profile_summary,
            commands::app::app_cancel_recruit,
            commands::app::app_get_user_info,
            commands::app::app_open_external,
            commands::app::app_reveal_in_file_manager,
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
            // ---- logs (Issue #326) ----
            commands::logs::logs_read_tail,
            commands::logs::logs_open_dir,
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
                                    payload.downcast_ref::<&'static str>().map(|s| s.to_string())
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
            // Issue #260 PR-1: 同じ settings 読み込みで `theme` も取り出し、glass テーマだったら
            // 起動時に Acrylic / Vibrancy を初期適用する (renderer の applyTheme から再適用される
            // までの空白で「透過 conf.json なのに effect 未適用 → 完全透明」になるのを防ぐ)。
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
                // Issue #260: theme が glass なら初期 effect を適用。
                // - tauri.conf.json で `transparent: true` + `backgroundColor: "#171716"` に
                //   なっており、起動瞬間は claude-dark の bg 相当の不透明色で覆われる。renderer
                //   が body の `--bg` を rgba(0,0,0,0) に書き換えてから OS chrome 越しに透過する
                //   ので、glass 以外のテーマで「OS 描画の背景がデスクトップ」になる起動 flash は
                //   起こらない。
                // - glass テーマは renderer のテーマ適用直後に Acrylic が乗るが、settings_load の
                //   disk read を待つ僅かな時間だけ「不透明 #171716 の上に panel が薄く乗る」状態
                //   になる。実機検証で気になるなら PR-2 でカスタム title bar 化と同時に再評価する。
                let theme = settings
                    .get("theme")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if theme == "glass" {
                    if let Some(win) = app_handle_for_root.get_webview_window("main") {
                        let res = commands::app::apply_window_effects_for_startup(&win, true);
                        tracing::info!(
                            "[setup] window-effects (glass) applied={} error={:?}",
                            res.applied,
                            res.error
                        );
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

    // Issue #155: builder.run().expect だと plugin 初期化失敗 / single_instance bind 失敗 /
    // setup 内 panic がすべて同じメッセージで死に、ユーザー報告から原因究明できない。
    // Err を構造化ログしてから exit code 1 で抜ける。
    if let Err(e) = builder.run(tauri::generate_context!()) {
        tracing::error!("[startup] tauri builder failed: {e:#}");
        eprintln!("vibe-editor failed to start: {e:#}");
        std::process::exit(1);
    }
}

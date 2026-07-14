// app.* command — 旧 src/main/ipc/app.ts に対応
//
// 実装方針:
// - ProjectRoot は AppState に保持し、CLI 引数 / 環境変数 / カレントディレクトリで初期化
use crate::state::AppState;
use serde::Serialize;
use tauri::{Manager, State};

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCheckResult {
    pub ok: bool,
    pub path: Option<String>,
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUserInfo {
    pub username: String,
    pub version: String,
    pub platform: String,
    pub tauri_version: String,
    pub webview_version: String,
}

#[tauri::command]
pub fn app_get_project_root(state: State<AppState>) -> String {
    // Issue #1193: active root が無いときに process cwd を返すと、renderer が未認可の
    // directory をあたかもactive rootであるかのように扱える。native authority ledger に
    // よって明示的に有効化されたrootだけを返す。
    crate::state::current_project_root(&state.project_root).unwrap_or_default()
}

/// Issue #951 / #952: 旧実装は `app.restart()` を直接呼ぶだけで、background task の
/// kill も行わず、旧プロセスの子 (claude/codex + 配下 MCP) が回収されないまま新プロセスと
/// 並走していた。CloseRequested handler (lib.rs) と同じ構造化シャットダウン
/// (task supervisor shutdown → blocking kill_all) を通してから restart する。
#[tauri::command]
pub async fn app_restart(app: tauri::AppHandle) {
    let state = app.state::<crate::state::AppState>();
    let drained = state
        .task_supervisor
        .shutdown(std::time::Duration::from_secs(3))
        .await;
    if !drained {
        tracing::warn!(
            "[lifecycle] app_restart: background task drain timeout — proceeding to kill_all"
        );
    }
    let registry = state.pty_registry.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        registry.kill_all_blocking(std::time::Duration::from_secs(2));
    })
    .await;
    tracing::info!("[lifecycle] app_restart: PTY shutdown complete — restarting");
    app.restart();
}
pub(crate) mod team_mcp;
pub(crate) mod updater;
pub(crate) mod window;

#[allow(unused_imports)]
pub(crate) use team_mcp::{
    app_cancel_recruit, app_cleanup_team_mcp, app_get_mcp_server_path, app_get_team_file_path,
    app_get_team_hub_info, app_recruit_ack, app_set_active_leader, app_set_role_profile_summary,
    app_setup_team_mcp, ActiveLeaderResult, CleanupTeamMcpResult, SetupTeamMcpResult, TeamHubInfo,
    TeamMcpMember,
};
#[allow(unused_imports)]
pub(crate) use updater::{
    app_updater_record_signature_warning, app_updater_should_warn_signature, ShouldWarnResult,
};
#[allow(unused_imports)]
pub(crate) use window::{
    app_open_external, app_reveal_in_file_manager, app_set_window_effects, app_set_window_title,
    app_set_zoom_level, apply_window_effects_for_startup, OpenExternalResult,
    SetWindowEffectsResult,
};
#[tauri::command]
pub fn app_get_user_info(app: tauri::AppHandle) -> AppUserInfo {
    tracing::info!("[IPC] app_get_user_info called");
    // whoami v2 で `username()` の戻り値が `Result<String, whoami::Error>` に変わったので、
    // 取得失敗時 (権限なし / OS API 失敗) は "unknown" にフォールバックして UI を壊さない。
    let username = whoami::username().unwrap_or_else(|_| "unknown".to_string());
    let webview_version = tauri::webview_version().unwrap_or_default();
    AppUserInfo {
        username,
        version: app.package_info().version.to_string(),
        platform: std::env::consts::OS.to_string(),
        tauri_version: tauri::VERSION.to_string(),
        webview_version,
    }
}

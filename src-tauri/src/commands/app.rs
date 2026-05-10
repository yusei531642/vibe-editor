// app.* command — 旧 src/main/ipc/app.ts に対応
//
// 実装方針:
// - ProjectRoot は AppState に保持し、CLI 引数 / 環境変数 / カレントディレクトリで初期化
use crate::state::AppState;
use serde::Serialize;
use tauri::State;

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
    // Issue #147: poison しても recovery して値を返す。
    crate::state::lock_project_root_recover(&state.project_root)
        .clone()
        .or_else(|| {
            std::env::current_dir()
                .ok()
                .map(|p| p.to_string_lossy().into_owned())
        })
        .unwrap_or_default()
}

/// Issue #29: renderer 側 (settings.lastOpenedRoot の変更 / Canvas-Sidebar の openFolder 等) で
/// プロジェクトルートが切り替わったとき、Rust 側 AppState の project_root を同期する。
/// この state は app_get_project_root と Claude session watcher 双方の SSOT。
///
/// Issue #66: 同時に FS watcher を再起動し、外部変更 (git pull / 他エディタ保存) を
/// `project:files-changed` イベントで renderer に通知する。
///
/// Issue #639 (Security): 改ざん bundle / DevTools から `app_set_project_root("/etc")` のような
/// system 領域への切替が直接可能だったため、`fs_watch::is_safe_watch_root` と同じ判断
/// (canonicalize / system 領域 denylist / home 直下拒否 / file ではなく dir であること) を
/// 入口で必ず通す。検証失敗時は `CommandError::Validation` で reject し、project_root state は
/// 変更しない (= 後続の git_*, fs_watch::start_for_root, file 読み書きが信頼できない場所で
/// 発火するのを TOCTOU 含めて阻止する)。
#[tauri::command]
pub fn app_set_project_root(
    app: tauri::AppHandle,
    state: State<AppState>,
    project_root: String,
) -> crate::commands::error::CommandResult<()> {
    let trimmed = project_root.trim().to_string();
    // Issue #639: 空文字 (= clear) はそのまま許可。非空時のみ system 領域 reject 検証を通す。
    if !trimmed.is_empty()
        && !crate::commands::fs_watch::is_safe_watch_root(std::path::Path::new(&trimmed))
    {
        return Err(crate::commands::error::CommandError::validation(format!(
            "project_root rejected by safety check (system / home / non-existent dir): {trimmed}"
        )));
    }
    // Issue #147: poison していても recovery して書き込む。失敗で常時死亡しない。
    let mut guard = crate::state::lock_project_root_recover(&state.project_root);
    *guard = if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.clone())
    };
    drop(guard);
    // Issue #66: watcher は project_root 変更ごとに付け替える
    if !trimmed.is_empty() {
        crate::commands::fs_watch::start_for_root(app, trimmed);
    }
    Ok(())
}

#[tauri::command]
pub fn app_restart(app: tauri::AppHandle) {
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

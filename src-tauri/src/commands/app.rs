// app.* command — 旧 src/main/ipc/app.ts に対応
//
// 実装方針:
// - ProjectRoot は AppState に保持し、CLI 引数 / 環境変数 / カレントディレクトリで初期化
// - チーム MCP 操作と TeamHub 情報は Phase 1 後半 (PTY/TeamHub Rust 化) で本実装
//   → 現時点では契約に合う型で「未実装」エラーや空値を返す stub

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
pub struct OpenExternalResult {
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SetupTeamMcpResult {
    pub ok: bool,
    pub error: Option<String>,
    pub socket: Option<String>,
    pub changed: Option<bool>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CleanupTeamMcpResult {
    pub ok: bool,
    pub error: Option<String>,
    pub removed: Option<bool>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TeamHubInfo {
    pub socket: String,
    pub token: String,
    pub bridge_path: String,
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

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMcpMember {
    pub agent_id: String,
    pub role: String,
    pub agent: String,
}

#[tauri::command]
pub fn app_get_project_root(state: State<AppState>) -> String {
    state
        .project_root
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
        .or_else(|| std::env::current_dir().ok().map(|p| p.to_string_lossy().into_owned()))
        .unwrap_or_default()
}

#[tauri::command]
pub fn app_restart(app: tauri::AppHandle) {
    app.restart();
}

#[tauri::command]
pub fn app_set_window_title(window: tauri::Window, title: String) -> Result<(), String> {
    window.set_title(&title).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn app_check_claude(command: String) -> ClaudeCheckResult {
    // 実装: PATH から command を which し、ok/path/error を返す
    let cmd = if command.trim().is_empty() {
        "claude".to_string()
    } else {
        command
    };
    match which::which(&cmd) {
        Ok(path) => ClaudeCheckResult {
            ok: true,
            path: Some(path.to_string_lossy().into_owned()),
            error: None,
        },
        Err(e) => ClaudeCheckResult {
            ok: false,
            path: None,
            error: Some(e.to_string()),
        },
    }
}

#[tauri::command]
pub fn app_set_zoom_level(_window: tauri::WebviewWindow, _level: f64) -> Result<(), String> {
    // Tauri 2 の zoom 制御は webview2 native API 経由 → Phase 1 後半で実装
    Ok(())
}

#[tauri::command]
pub fn app_get_zoom_level(_window: tauri::WebviewWindow) -> f64 {
    1.0
}

#[tauri::command]
pub async fn app_setup_team_mcp(
    state: State<'_, AppState>,
    _project_root: String,
    team_id: String,
    team_name: String,
    _members: Vec<TeamMcpMember>,
) -> Result<SetupTeamMcpResult, String> {
    let hub = state.team_hub.clone();
    // 念のため Hub を起動 (setup でも spawn 済み)
    if let Err(e) = hub.start().await {
        return Ok(SetupTeamMcpResult {
            ok: false,
            error: Some(format!("teamhub start failed: {e:#}")),
            ..Default::default()
        });
    }
    hub.register_team(&team_id, &team_name).await;
    let (port, token, bridge_path) = hub.info().await;
    let socket = format!("127.0.0.1:{port}");
    let desired = crate::mcp_config::bridge_desired(&socket, &token, &bridge_path);

    let mut changed = false;
    match crate::mcp_config::claude::setup(&desired).await {
        Ok(c) => changed |= c,
        Err(e) => {
            return Ok(SetupTeamMcpResult {
                ok: false,
                error: Some(format!("claude mcp setup: {e:#}")),
                ..Default::default()
            })
        }
    }
    if let Err(e) = crate::mcp_config::codex::setup(&bridge_path).await {
        return Ok(SetupTeamMcpResult {
            ok: false,
            error: Some(format!("codex mcp setup: {e:#}")),
            ..Default::default()
        });
    }
    Ok(SetupTeamMcpResult {
        ok: true,
        socket: Some(socket),
        changed: Some(changed),
        error: None,
    })
}

#[tauri::command]
pub async fn app_cleanup_team_mcp(
    state: State<'_, AppState>,
    _project_root: String,
    team_id: String,
) -> Result<CleanupTeamMcpResult, String> {
    let last = state.team_hub.clear_team(&team_id).await;
    let mut removed = false;
    if last {
        // 残りアクティブチームが 0 になったら MCP 設定を削除
        match crate::mcp_config::claude::cleanup().await {
            Ok(r) => removed |= r,
            Err(e) => {
                return Ok(CleanupTeamMcpResult {
                    ok: false,
                    error: Some(format!("claude mcp cleanup: {e:#}")),
                    removed: None,
                })
            }
        }
        if let Err(e) = crate::mcp_config::codex::cleanup().await {
            return Ok(CleanupTeamMcpResult {
                ok: false,
                error: Some(format!("codex mcp cleanup: {e:#}")),
                removed: None,
            });
        }
        removed = true;
    }
    Ok(CleanupTeamMcpResult {
        ok: true,
        removed: Some(removed),
        error: None,
    })
}

#[tauri::command]
pub fn app_get_team_file_path(team_id: String) -> String {
    let home = dirs::home_dir().unwrap_or_default();
    home.join(".vibe-editor")
        .join(format!("team-{team_id}.json"))
        .to_string_lossy()
        .into_owned()
}

#[tauri::command]
pub async fn app_get_mcp_server_path(state: State<'_, AppState>) -> Result<String, String> {
    let (_, _, bridge_path) = state.team_hub.info().await;
    Ok(bridge_path)
}

#[tauri::command]
pub async fn app_get_team_hub_info(
    state: State<'_, AppState>,
) -> Result<TeamHubInfo, String> {
    let (port, token, bridge_path) = state.team_hub.info().await;
    Ok(TeamHubInfo {
        socket: format!("127.0.0.1:{port}"),
        token,
        bridge_path,
    })
}

#[tauri::command]
pub fn app_get_user_info(app: tauri::AppHandle) -> AppUserInfo {
    tracing::info!("[IPC] app_get_user_info called");
    let username = whoami::username();
    let webview_version = tauri::webview_version().unwrap_or_default();
    AppUserInfo {
        username,
        version: app.package_info().version.to_string(),
        platform: std::env::consts::OS.to_string(),
        tauri_version: tauri::VERSION.to_string(),
        webview_version,
    }
}

#[tauri::command]
pub async fn app_open_external(
    app: tauri::AppHandle,
    url: String,
) -> OpenExternalResult {
    use tauri_plugin_opener::OpenerExt;
    match app.opener().open_url(&url, None::<&str>) {
        Ok(_) => OpenExternalResult {
            ok: true,
            error: None,
        },
        Err(e) => OpenExternalResult {
            ok: false,
            error: Some(e.to_string()),
        },
    }
}

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

/// Issue #29: renderer 側 (settings.lastOpenedRoot の変更 / Canvas-Sidebar の openFolder 等) で
/// プロジェクトルートが切り替わったとき、Rust 側 AppState の project_root を同期する。
/// この state は app_get_project_root と Claude session watcher 双方の SSOT。
///
/// Issue #66: 同時に FS watcher を再起動し、外部変更 (git pull / 他エディタ保存) を
/// `project:files-changed` イベントで renderer に通知する。
#[tauri::command]
pub fn app_set_project_root(
    app: tauri::AppHandle,
    state: State<AppState>,
    project_root: String,
) -> Result<(), String> {
    let mut guard = state
        .project_root
        .lock()
        .map_err(|e| format!("project_root lock poisoned: {e}"))?;
    let trimmed = project_root.trim().to_string();
    *guard = if trimmed.is_empty() { None } else { Some(trimmed.clone()) };
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
pub fn app_set_zoom_level(window: tauri::WebviewWindow, level: f64) -> Result<(), String> {
    // Tauri 2: WebviewWindow::set_zoom でネイティブ zoom を適用。
    // 引数は Electron の webFrame.setZoomFactor 相当の factor (1.0 = 100%)。
    // 再レイアウトを伴うので CSS transform: scale() と違いテキストがピクセル完全描画される。
    // get API は WebView2 / wry に無いため、フロント (webview-zoom.ts) で last-set 値を保持する。
    let clamped = level.clamp(0.3, 3.0);
    window.set_zoom(clamped).map_err(|e| e.to_string())?;
    Ok(())
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

/// Issue #49: 許可するスキームの allowlist。
/// - `http`/`https`: 通常の Web ページ (Release ページ、ドキュメント等)
/// - `mailto`: メール feedback
/// それ以外 (`file:`, `javascript:`, `data:`, OS カスタムプロトコル) は拒否する。
const ALLOWED_EXTERNAL_SCHEMES: &[&str] = &["http", "https", "mailto"];

fn is_safe_external_url(url: &str) -> bool {
    // scheme を手動抽出 (url crate を避け依存追加を不要にする)
    let trimmed = url.trim();
    if trimmed.is_empty() || trimmed.len() > 8192 {
        return false;
    }
    let colon = match trimmed.find(':') {
        Some(i) => i,
        None => return false,
    };
    let scheme = &trimmed[..colon];
    // scheme は ASCII 英数 + `-.+` のみが RFC 的に許容
    if !scheme
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.')
    {
        return false;
    }
    ALLOWED_EXTERNAL_SCHEMES
        .iter()
        .any(|s| scheme.eq_ignore_ascii_case(s))
}

#[tauri::command]
pub async fn app_open_external(
    app: tauri::AppHandle,
    url: String,
) -> OpenExternalResult {
    use tauri_plugin_opener::OpenerExt;
    // Issue #49: スキーム検証 — allowlist 外は即拒否
    if !is_safe_external_url(&url) {
        tracing::warn!("[app_open_external] rejected unsafe url scheme: {url}");
        return OpenExternalResult {
            ok: false,
            error: Some(format!(
                "disallowed url scheme (allowed: {ALLOWED_EXTERNAL_SCHEMES:?})"
            )),
        };
    }
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

#[cfg(test)]
mod open_external_tests {
    use super::is_safe_external_url;

    #[test]
    fn accepts_http_https_mailto() {
        assert!(is_safe_external_url("https://github.com/"));
        assert!(is_safe_external_url("http://localhost:5173"));
        assert!(is_safe_external_url("mailto:foo@example.com"));
    }

    #[test]
    fn rejects_dangerous_schemes() {
        assert!(!is_safe_external_url("file:///etc/passwd"));
        assert!(!is_safe_external_url("javascript:alert(1)"));
        assert!(!is_safe_external_url("data:text/html,<script>"));
        assert!(!is_safe_external_url("ms-settings:privacy"));
        assert!(!is_safe_external_url(""));
        assert!(!is_safe_external_url("noscheme"));
    }
}

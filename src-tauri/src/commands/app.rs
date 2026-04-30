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

// Issue #336: 全フィールドが現状未参照だが、renderer から `app_setup_team_mcp` に
// 渡される情報のシグネチャを保つため struct ごと保持する。将来 MCP 設定生成や
// telemetry で読み出しを再開する想定。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct TeamMcpMember {
    pub agent_id: String,
    pub role: String,
    pub agent: String,
}

#[tauri::command]
pub fn app_get_project_root(state: State<AppState>) -> String {
    // Issue #147: poison しても recovery して値を返す。
    crate::state::lock_project_root_recover(&state.project_root)
        .clone()
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
    // Issue #147: poison していても recovery して書き込む。失敗で常時死亡しない。
    let mut guard = crate::state::lock_project_root_recover(&state.project_root);
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

/// Issue #137 (Security): app_check_claude は which::which で任意 path を叩けるため、
/// renderer から `app_check_claude("/Users/victim/.ssh/id_rsa")` のように呼ぶと
/// 任意ファイル/ディレクトリの存在確認 (fingerprint) になってしまう。
///
/// 防御策:
///   - 絶対パス / `/` / `\` を含む値は reject (PATH 経由の lookup だけ許可)
///   - 文字列を制限 ([A-Za-z0-9_.-] のみ)。シェル特殊文字を排除
#[tauri::command]
pub async fn app_check_claude(command: String) -> ClaudeCheckResult {
    let raw = command.trim();
    let cmd = if raw.is_empty() { "claude" } else { raw };
    if cmd.contains('/')
        || cmd.contains('\\')
        || std::path::Path::new(cmd).is_absolute()
        || !cmd
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
    {
        return ClaudeCheckResult {
            ok: false,
            path: None,
            error: Some("invalid command name (only PATH lookup of bare names is allowed)".into()),
        };
    }
    match which::which(cmd) {
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

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SetWindowEffectsResult {
    pub ok: bool,
    /// OS ネイティブ effect が実際に適用されたか。Linux 等の非対応プラットフォームや
    /// 古い Windows ビルドでは false。renderer は CSS backdrop-filter フォールバックに
    /// デグラデする判断材料として使う。
    pub applied: bool,
    pub error: Option<String>,
}

/// Issue #260 PR-1: テーマに応じて OS ネイティブの window effect を切り替える。
/// - Windows: `glass` テーマで Acrylic (PowerShell の Windows Terminal 同等の動的ぼかし)
/// - macOS: `glass` テーマで under-window vibrancy
/// - Linux: 非対応 (no-op、ok=true / applied=false)
/// 他テーマ (claude-dark / claude-light / dark / midnight / light) では effect を解除し、
/// 通常の不透明背景に戻す。
///
/// 戻り値は `SetWindowEffectsResult` (Result でラップしない) — 自己レビュー D-3C。
/// IPC 自体は失敗せず、OS 側の applied 状態は `applied` フィールドで返す方針。
#[tauri::command]
pub fn app_set_window_effects(
    window: tauri::WebviewWindow,
    theme: String,
) -> SetWindowEffectsResult {
    let is_glass = theme == "glass";
    apply_window_effects(&window, is_glass)
}

/// 起動時の初期適用 (`lib.rs` の `setup` から呼ぶ)。`#[tauri::command]` 関数を internal で
/// 直接呼ぶと State 引数を取り始めた瞬間に破綻するため、純関数として `pub(crate)` で公開。
pub(crate) fn apply_window_effects_for_startup(
    window: &tauri::WebviewWindow,
    is_glass: bool,
) -> SetWindowEffectsResult {
    apply_window_effects(window, is_glass)
}

#[cfg(target_os = "windows")]
fn apply_window_effects(
    window: &tauri::WebviewWindow,
    is_glass: bool,
) -> SetWindowEffectsResult {
    use tauri::window::{Effect, EffectState, EffectsBuilder};
    if is_glass {
        let cfg = EffectsBuilder::new()
            .effect(Effect::Acrylic)
            .state(EffectState::Active)
            .build();
        match window.set_effects(cfg) {
            Ok(_) => SetWindowEffectsResult {
                ok: true,
                applied: true,
                error: None,
            },
            Err(e) => {
                tracing::warn!("[window-effects] set_effects(Acrylic) failed: {e}");
                SetWindowEffectsResult {
                    ok: true,
                    applied: false,
                    error: Some(e.to_string()),
                }
            }
        }
    } else {
        // 非 Glass テーマ: None を渡して effect を解除。
        // 自己レビュー D-3B: 解除失敗時も warn + error に詰める (Glass→他テーマ復帰失敗の可視化)。
        match window.set_effects(None) {
            Ok(_) => SetWindowEffectsResult {
                ok: true,
                applied: false,
                error: None,
            },
            Err(e) => {
                tracing::warn!("[window-effects] set_effects(None) failed: {e}");
                SetWindowEffectsResult {
                    ok: true,
                    applied: false,
                    error: Some(e.to_string()),
                }
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn apply_window_effects(
    window: &tauri::WebviewWindow,
    is_glass: bool,
) -> SetWindowEffectsResult {
    use tauri::window::{Effect, EffectsBuilder};
    if is_glass {
        let cfg = EffectsBuilder::new()
            .effect(Effect::UnderWindowBackground)
            .build();
        match window.set_effects(cfg) {
            Ok(_) => SetWindowEffectsResult {
                ok: true,
                applied: true,
                error: None,
            },
            Err(e) => {
                tracing::warn!("[window-effects] set_effects(UnderWindowBackground) failed: {e}");
                SetWindowEffectsResult {
                    ok: true,
                    applied: false,
                    error: Some(e.to_string()),
                }
            }
        }
    } else {
        match window.set_effects(None) {
            Ok(_) => SetWindowEffectsResult {
                ok: true,
                applied: false,
                error: None,
            },
            Err(e) => {
                tracing::warn!("[window-effects] set_effects(None) failed: {e}");
                SetWindowEffectsResult {
                    ok: true,
                    applied: false,
                    error: Some(e.to_string()),
                }
            }
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn apply_window_effects(
    _window: &tauri::WebviewWindow,
    _is_glass: bool,
) -> SetWindowEffectsResult {
    // Linux 等は windowEffects 非対応 (Tauri 2 docs: "Linux: Unsupported")。
    // CSS backdrop-filter のみで擬似 Glass を維持する。
    SetWindowEffectsResult {
        ok: true,
        applied: false,
        error: None,
    }
}

#[tauri::command]
pub async fn app_setup_team_mcp(
    state: State<'_, AppState>,
    project_root: String,
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

    // vibe-team Skill ファイルを best-effort で配置/同期する。
    // setupTeamMcp は「_init」ウォームアップ呼び出しでも、実チーム起動でも、復元呼び出しでも走る。
    // どのケースでも install_skill_best_effort はバージョンヘッダで idempotent (内容一致なら no-op、
    // 同バージョンヘッダで内容差分があれば自動上書き、ヘッダ無しのユーザー編集ファイルには触らない)
    // なので team_id を問わず常に呼んでよい。アプリ起動毎に最新の SKILL.md が確実に同期される。
    //
    // Issue #191 (Security): 旧実装は renderer 由来の project_root をそのまま install に流して
    // いたため、改ざん済み bundled JS から任意ディレクトリ配下に SKILL.md を plant 可能だった
    // (#135 で app_install_vibe_team_skill だけに付けたガードが、setup 経路では空転していた)。
    // → app_install_vibe_team_skill と同じく req_canon == active_canon を検証してから install する。
    let trimmed = project_root.trim();
    if !trimmed.is_empty() {
        let active = crate::state::lock_project_root_recover(&state.project_root)
            .clone()
            .unwrap_or_default();
        if active.trim().is_empty() {
            tracing::warn!(
                "[setup_team_mcp] skipping skill install: no active project_root configured"
            );
        } else {
            // canonicalize は async fn 内では tokio::fs を使う (network mount 等で blocking I/O が
            // Tokio worker を塞ぐのを避けるため)。req と active は独立なので join で並列実行。
            let (req_res, active_res) = tokio::join!(
                tokio::fs::canonicalize(trimmed),
                tokio::fs::canonicalize(active.trim())
            );
            match (req_res, active_res) {
                (Ok(req_canon), Ok(active_canon)) if req_canon == active_canon => {
                    crate::commands::vibe_team_skill::install_skill_best_effort(
                        &req_canon.to_string_lossy(),
                    )
                    .await;
                }
                (Ok(req_canon), Ok(active_canon)) => {
                    tracing::warn!(
                        "[setup_team_mcp] skill install denied: requested {} != active {}",
                        req_canon.display(),
                        active_canon.display()
                    );
                }
                (req_res, active_res) => {
                    // どちらか / 両方失敗。両方分けて出すことで「片方だけ失敗 → ディスク破損疑い」
                    // 「両方失敗 → 設定経路の不整合」のデバッグ材料を残す。
                    if let Err(e) = req_res {
                        tracing::warn!(
                            "[setup_team_mcp] canonicalize requested project_root failed: {e}"
                        );
                    }
                    if let Err(e) = active_res {
                        tracing::warn!(
                            "[setup_team_mcp] canonicalize active project_root failed: {e}"
                        );
                    }
                }
            }
        }
    }
    let (socket, token, bridge_path) = hub.info().await;
    let desired = crate::mcp_config::bridge_desired(&socket, &token, &bridge_path);

    // Issue #118: claude / codex のどちらか片方だけが書き換わった「半端状態」を残さない。
    // 事前にスナップショットを取り、claude→codex の順に書く。codex で失敗したら claude を rollback。
    let claude_snap = match crate::mcp_config::claude::snapshot().await {
        Ok(s) => s,
        Err(e) => {
            return Ok(SetupTeamMcpResult {
                ok: false,
                error: Some(format!("claude mcp snapshot: {e:#}")),
                ..Default::default()
            });
        }
    };

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
        // claude 側を元に戻す。rollback 自体が失敗した場合はログに残し、ユーザーには両方
        // 失敗したことを返す (ユーザーが手動で `~/.claude.json` を確認できるようメッセージで促す)。
        let mut error_msg = format!("codex mcp setup: {e:#}");
        if let Err(re) = crate::mcp_config::claude::restore(claude_snap).await {
            tracing::error!("[mcp] claude rollback failed after codex setup error: {re:#}");
            error_msg = format!(
                "{error_msg} (rollback claude also failed: {re:#}; please review ~/.claude.json manually)"
            );
        } else {
            tracing::warn!("[mcp] codex setup failed, claude rolled back to previous state");
        }
        return Ok(SetupTeamMcpResult {
            ok: false,
            error: Some(error_msg),
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
        // Issue #118: 片側だけ vibe-team 行が消えた半端状態を残さない。
        // 事前にスナップショットを取り、codex 側で失敗したら claude を元に戻す。
        let claude_snap = match crate::mcp_config::claude::snapshot().await {
            Ok(s) => s,
            Err(e) => {
                return Ok(CleanupTeamMcpResult {
                    ok: false,
                    error: Some(format!("claude mcp snapshot: {e:#}")),
                    removed: None,
                });
            }
        };

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
            let mut error_msg = format!("codex mcp cleanup: {e:#}");
            if let Err(re) = crate::mcp_config::claude::restore(claude_snap).await {
                tracing::error!("[mcp] claude rollback failed after codex cleanup error: {re:#}");
                error_msg = format!(
                    "{error_msg} (rollback claude also failed: {re:#}; please review ~/.claude.json manually)"
                );
            } else {
                tracing::warn!(
                    "[mcp] codex cleanup failed, claude restored to previous state"
                );
            }
            return Ok(CleanupTeamMcpResult {
                ok: false,
                error: Some(error_msg),
                removed: None,
            });
        }
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
    let (socket, token, bridge_path) = state.team_hub.info().await;
    Ok(TeamHubInfo {
        socket,
        token,
        bridge_path,
    })
}

/// renderer 側で構築した role profile summary を TeamHub に同期する。
/// MCP の team_list_role_profiles と permissions 検証で参照される。
#[tauri::command]
pub async fn app_set_role_profile_summary(
    state: State<'_, AppState>,
    summary: Vec<crate::team_hub::RoleProfileSummary>,
) -> Result<(), String> {
    state.team_hub.set_role_profile_summary(summary).await;
    Ok(())
}

/// recruit 完了時 / cancel 時に renderer から呼ぶ。
/// 主に手動 cancel (ユーザーがカードを × で閉じた等) に使う。
#[tauri::command]
pub async fn app_cancel_recruit(
    state: State<'_, AppState>,
    agent_id: String,
) -> Result<(), String> {
    state.team_hub.cancel_pending_recruit(&agent_id).await;
    Ok(())
}

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

/// Issue #251: OS のファイルマネージャ (Explorer / Finder / Nautilus) を開いて
/// 該当ファイルをハイライトする。renderer から `api.app.revealInFileManager(absPath)` 経由で呼ぶ。
///
/// セキュリティ:
///   - 絶対パスのみ許可 (PATH lookup や CWD 相対は拒否)
///   - パストラバーサル (`..`) を拒否
///   - 4096 文字超は拒否 (OS によっては DoS 抑止)
#[tauri::command]
pub async fn app_reveal_in_file_manager(
    app: tauri::AppHandle,
    path: String,
) -> OpenExternalResult {
    use tauri_plugin_opener::OpenerExt;

    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed.len() > 4096 {
        return OpenExternalResult {
            ok: false,
            error: Some("invalid path length".into()),
        };
    }
    let p = std::path::Path::new(trimmed);
    if !p.is_absolute() {
        return OpenExternalResult {
            ok: false,
            error: Some("only absolute path is allowed".into()),
        };
    }
    if p.components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return OpenExternalResult {
            ok: false,
            error: Some("path traversal (..) is not allowed".into()),
        };
    }
    match app.opener().reveal_item_in_dir(p) {
        Ok(_) => OpenExternalResult {
            ok: true,
            error: None,
        },
        Err(e) => {
            tracing::warn!("[app_reveal_in_file_manager] failed: {e}");
            OpenExternalResult {
                ok: false,
                error: Some(e.to_string()),
            }
        }
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

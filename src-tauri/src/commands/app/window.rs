use crate::commands::app::ClaudeCheckResult;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenExternalResult {
    pub ok: bool,
    pub error: Option<String>,
}

#[tauri::command]
pub fn app_set_window_title(
    window: tauri::Window,
    title: String,
) -> crate::commands::error::CommandResult<()> {
    Ok(window.set_title(&title).map_err(|e| e.to_string())?)
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
pub fn app_set_zoom_level(
    window: tauri::WebviewWindow,
    level: f64,
) -> crate::commands::error::CommandResult<()> {
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
fn apply_window_effects(window: &tauri::WebviewWindow, is_glass: bool) -> SetWindowEffectsResult {
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
fn apply_window_effects(window: &tauri::WebviewWindow, is_glass: bool) -> SetWindowEffectsResult {
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
fn apply_window_effects(_window: &tauri::WebviewWindow, _is_glass: bool) -> SetWindowEffectsResult {
    // Linux 等は windowEffects 非対応 (Tauri 2 docs: "Linux: Unsupported")。
    // CSS backdrop-filter のみで擬似 Glass を維持する。
    SetWindowEffectsResult {
        ok: true,
        applied: false,
        error: None,
    }
}

/// Issue #49: 許可するスキームの allowlist。
/// - `http`/`https`: 通常の Web ページ (Release ページ、ドキュメント等)
/// - `mailto`: メール feedback
///
/// それ以外 (`file:`, `javascript:`, `data:`, OS カスタムプロトコル) は拒否する。
const ALLOWED_EXTERNAL_SCHEMES: &[&str] = &["http", "https", "mailto"];

fn is_safe_external_url(url: &str) -> bool {
    // scheme を手動抽出 (url crate を避け依存追加を不要にする)
    let trimmed = url.trim();
    if trimmed.is_empty() || trimmed.len() > 8192 {
        return false;
    }
    let Some(colon) = trimmed.find(':') else {
        return false;
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
pub async fn app_open_external(app: tauri::AppHandle, url: String) -> OpenExternalResult {
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
pub async fn app_reveal_in_file_manager(app: tauri::AppHandle, path: String) -> OpenExternalResult {
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

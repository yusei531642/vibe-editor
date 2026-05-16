// settings.* command — 旧 src/main/ipc/settings.ts に対応
//
// userData/settings.json に AppSettings を保存。
// 既存 Electron では app.getPath('userData') を使っていたが、
// Tauri では `~/.vibe-editor/settings.json` に統一する (シンプル化)。
//
// Issue #493 (Phase 2): 旧 `serde_json::Value` 直渡しを `Settings` strong-typed struct に
// 置換した。`#[serde(rename_all = "camelCase")]` で renderer 側の AppSettings と完全一致、
// `#[serde(default)]` で旧バージョン (schemaVersion=2 等) からの load を許容する。
// 不正な型 (`claudeArgs` が string でない等) は Tauri IPC layer で自動 reject され、renderer 側
// `invoke()` の Promise が reject される (renderer 側 SettingsContext で Toast 表示済み)。
//
// 列挙値 (`theme` / `density` / `language` / `statusMascotVariant`) は `String` で受ける。
// 既存値が新バージョンの ThemeName 等にマッチしないケースを silent に消さないため。
// 不正値は renderer 側 `migrateSettings` が default にフォールバックする。

use crate::commands::atomic_write::atomic_write;
use crate::commands::error::{CommandError, CommandResult};
use crate::util::backup::write_timestamped_backup;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::fs;
use tokio::sync::Mutex;

/// Issue #37: 並列 save を直列化する。atomic_write だけでは同時 2 save で
/// どちらかが temp rename 競合して 1 つが失敗しうるが、この Mutex で書き込みを 1 つずつに。
static SAVE_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

/// `~/.vibe-editor/settings.json` の serde 表現。renderer 側 `src/types/shared.ts` の
/// `AppSettings` と完全一致 (camelCase ですべての field が同名・同型)。
///
/// 設計指針:
/// - 必須フィールドにも `#[serde(default = "...")]` を付けて、旧バージョンの settings.json から
///   load しても missing field でエラーにならないようにする。
/// - 列挙系 (theme/density/language/statusMascotVariant) は `String` で受け、enum 化はしない。
///   既存ユーザーの値が新 ThemeName ユニオンにマッチしないとき、silent に default に戻すと
///   ユーザー設定が消失する事故が起きるため、value 検証は renderer 側 `migrateSettings` に任せる。
/// - 真に optional (renderer 側 `?` 付き) なフィールドは `Option<T>` で、`None` のときは
///   `skip_serializing_if` で JSON 出力から省略 (renderer migration が "存在しない" 判定で
///   default 投入してくれる)。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema_version: Option<u32>,
    #[serde(default = "default_language")]
    pub language: String,
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default = "default_ui_font_family")]
    pub ui_font_family: String,
    #[serde(default = "default_ui_font_size")]
    pub ui_font_size: f64,
    #[serde(default = "default_editor_font_family")]
    pub editor_font_family: String,
    #[serde(default = "default_editor_font_size")]
    pub editor_font_size: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_font_family: Option<String>,
    #[serde(default = "default_terminal_font_size")]
    pub terminal_font_size: f64,
    #[serde(default = "default_density")]
    pub density: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_mascot_variant: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_mascot_custom_path: Option<String>,

    // ---------- Claude Code 起動オプション ----------
    #[serde(default = "default_claude_command")]
    pub claude_command: String,
    #[serde(default)]
    pub claude_args: String,
    #[serde(default)]
    pub claude_cwd: String,
    #[serde(default)]
    pub last_opened_root: String,
    #[serde(default)]
    pub recent_projects: Vec<String>,
    #[serde(default)]
    pub workspace_folders: Vec<String>,
    #[serde(default = "default_claude_code_panel_width")]
    pub claude_code_panel_width: f64,
    #[serde(default = "default_sidebar_width")]
    pub sidebar_width: f64,

    // ---------- Codex ----------
    #[serde(default = "default_codex_command")]
    pub codex_command: String,
    #[serde(default)]
    pub codex_args: String,

    #[serde(default)]
    pub notepad: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_completed_onboarding: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_agents: Option<Vec<AgentConfig>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_auto_setup: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webview_zoom: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_tree_expanded: Option<HashMap<String, Vec<String>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_tree_collapsed_roots: Option<Vec<String>>,
    /// Issue #618: Windows ConPTY で cmd.exe / PowerShell を起動する際に、初期コマンドとして
    /// `chcp 65001` 等を inject して console output を UTF-8 へ強制するか (default true)。
    /// 既存ユーザーは renderer 側 v10→v11 migration で `true` が入る。
    #[serde(default = "default_terminal_force_utf8")]
    pub terminal_force_utf8: bool,
}

/// shared.ts `AgentConfig` を mirror。`cwd` / `color` は optional。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    pub id: String,
    pub name: String,
    pub command: String,
    pub args: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

// `Settings::default()` は renderer の `DEFAULT_SETTINGS` と一致させる。
// initial install で settings.json が無いとき / parse 失敗時に返す値。
impl Default for Settings {
    fn default() -> Self {
        Self {
            schema_version: Some(APP_SETTINGS_SCHEMA_VERSION),
            language: default_language(),
            theme: default_theme(),
            ui_font_family: default_ui_font_family(),
            ui_font_size: default_ui_font_size(),
            editor_font_family: default_editor_font_family(),
            editor_font_size: default_editor_font_size(),
            terminal_font_family: Some(default_terminal_font_family()),
            terminal_font_size: default_terminal_font_size(),
            density: default_density(),
            status_mascot_variant: Some("vibe".to_string()),
            status_mascot_custom_path: None,
            claude_command: default_claude_command(),
            claude_args: String::new(),
            claude_cwd: String::new(),
            last_opened_root: String::new(),
            recent_projects: Vec::new(),
            workspace_folders: Vec::new(),
            claude_code_panel_width: default_claude_code_panel_width(),
            sidebar_width: default_sidebar_width(),
            codex_command: default_codex_command(),
            codex_args: String::new(),
            notepad: String::new(),
            has_completed_onboarding: Some(false),
            custom_agents: Some(Vec::new()),
            mcp_auto_setup: Some(true),
            webview_zoom: None,
            file_tree_expanded: Some(HashMap::new()),
            file_tree_collapsed_roots: Some(Vec::new()),
            terminal_force_utf8: default_terminal_force_utf8(),
        }
    }
}

/// Issue #618: Windows ConPTY + cmd.exe / PowerShell の出力 UTF-8 強制 (default true)。
fn default_terminal_force_utf8() -> bool {
    true
}

// ---- per-field defaults (`#[serde(default = "...")]` から参照) ----
//
// renderer 側 `DEFAULT_SETTINGS` と完全一致させる。新フィールド追加時は両方を同時に更新する。

/// Issue #75 / #449 / #618: 現在のスキーマ版数。`shared.ts APP_SETTINGS_SCHEMA_VERSION` と同期。
pub const APP_SETTINGS_SCHEMA_VERSION: u32 = 11;

fn default_language() -> String {
    "ja".to_string()
}

fn default_theme() -> String {
    "claude-dark".to_string()
}

fn default_ui_font_family() -> String {
    "'Inter Variable', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', \
     'Hiragino Sans', 'Yu Gothic UI', sans-serif"
        .to_string()
}

fn default_ui_font_size() -> f64 {
    14.0
}

fn default_editor_font_family() -> String {
    "'JetBrains Mono Variable', 'Geist Mono Variable', 'Cascadia Code', 'Consolas', monospace"
        .to_string()
}

fn default_editor_font_size() -> f64 {
    13.0
}

fn default_terminal_font_family() -> String {
    "'JetBrainsMono Nerd Font Mono', 'JetBrains Mono Variable', 'Cascadia Mono', \
     'Cascadia Code', Consolas, 'Lucida Console', 'Segoe UI Symbol', monospace"
        .to_string()
}

fn default_terminal_font_size() -> f64 {
    13.0
}

fn default_density() -> String {
    "normal".to_string()
}

fn default_claude_command() -> String {
    "claude".to_string()
}

fn default_codex_command() -> String {
    "codex".to_string()
}

fn default_claude_code_panel_width() -> f64 {
    460.0
}

fn default_sidebar_width() -> f64 {
    272.0
}

#[tauri::command]
pub async fn settings_load() -> Settings {
    tracing::info!("[IPC] settings_load called");
    let path = crate::util::config_paths::settings_path();
    let Ok(bytes) = fs::read(&path).await else {
        // Issue #29: 初回起動 / 読み取り不能時は default を返す。renderer 側 `migrateSettings`
        // は schemaVersion=10 (current) で呼ばれることになるので migration は no-op、
        // shallow merge で DEFAULT_SETTINGS と一致した値が settingsRef に乗る。
        return Settings::default();
    };
    match serde_json::from_slice::<Settings>(&bytes) {
        Ok(v) => v,
        Err(e) => {
            // Issue #170: 旧実装は parse 失敗時に黙って Null を返し、次の save で
            // ユーザー設定が完全消失する事故が起きていた。.bak に元ファイルを退避してから
            // default を返すことで、ユーザーが手動で復元できるようにする。
            // Issue #493: strong-typing 後も `.bak` 退避は同じ流儀で維持する。
            // Issue #644: 旧実装は単一 `.bak` を都度上書きしていたため、連続破損保存で
            // 健全な原本が 1 ステップで失われていた。タイムスタンプ付き backup +
            // 世代回転 (5 世代) に変更し、過去 5 ステップ分の原本に戻れるようにする。
            tracing::error!(
                "[settings] parse failed ({}), backing up to {}.bak.<ts>",
                e,
                path.display()
            );
            // best-effort: バックアップが取れなくても続行
            match write_timestamped_backup(&path, &bytes, None).await {
                Ok(bak) => tracing::info!(
                    "[settings] wrote timestamped backup: {}",
                    bak.display()
                ),
                Err(berr) => tracing::warn!("[settings] backup write failed: {berr}"),
            }
            Settings::default()
        }
    }
}

/// Issue #641: settings_save に schema_version 互換性ガードを実装する内部関数。
///
/// 設計:
/// - `disk_schema_version` (= 既存 settings.json から読んだ `schema_version`) と
///   `incoming_schema_version` (= renderer から渡された `Settings.schema_version`) を比較し、
///   以下の 2 ケースで save を reject する:
///   1. **disk が新しいバージョン**: `disk_schema_version > APP_SETTINGS_SCHEMA_VERSION`。
///      旧 build が起動して新スキーマの settings.json を上書きしようとしたケース。
///      旧 build の serde は新フィールドを `unknown_fields` として silent drop しているため、
///      そのまま書き戻すと新フィールドが永続的に消える。
///   2. **incoming が未来バージョン**: `incoming > APP_SETTINGS_SCHEMA_VERSION`。
///      renderer が migration で意図しない future version を渡してきたケース (通常は発生しない
///      が、複数 vibe-editor インスタンス間の race / 改竄 settings.json を読んだ等で起こり得る)。
/// - reject は `CommandError::Validation` で renderer 側に返し、Toast で「新しい vibe-editor が
///   この設定を作成しました。最新版に更新してから保存してください。」と表示する経路。
/// - **下回るバージョン (incoming < current) は accept する**: renderer 側 `migrateSettings` が
///   現行 schema へ前進させた後に save するので、通常 incoming は current と一致する。仮に
///   incoming のほうが古くても、disk のほうも同等以下であれば情報損失リスクは無い (= 同一バイナリ
///   の前進 migration として扱える)。
pub(crate) fn check_schema_compat(
    disk_schema_version: Option<u32>,
    incoming_schema_version: Option<u32>,
) -> Result<(), CommandError> {
    // case 1: 旧 build が新スキーマの disk を上書きしようとしている
    if let Some(disk_v) = disk_schema_version {
        if disk_v > APP_SETTINGS_SCHEMA_VERSION {
            tracing::warn!(
                disk_schema_version = disk_v,
                current_schema_version = APP_SETTINGS_SCHEMA_VERSION,
                "[settings_save] rejected: disk has newer schema than this build",
            );
            return Err(CommandError::validation(format!(
                "settings.json was created by a newer vibe-editor (schema v{disk_v}, this build supports v{APP_SETTINGS_SCHEMA_VERSION}). \
                 Update vibe-editor before saving settings to avoid losing newer fields."
            )));
        }
    }
    // case 2: renderer から未来バージョンが渡された
    if let Some(incoming_v) = incoming_schema_version {
        if incoming_v > APP_SETTINGS_SCHEMA_VERSION {
            tracing::warn!(
                incoming_schema_version = incoming_v,
                current_schema_version = APP_SETTINGS_SCHEMA_VERSION,
                "[settings_save] rejected: incoming settings declare future schema",
            );
            return Err(CommandError::validation(format!(
                "Incoming settings declare a future schema (v{incoming_v}, this build supports v{APP_SETTINGS_SCHEMA_VERSION}). \
                 Refusing to overwrite to avoid silent field loss."
            )));
        }
    }
    Ok(())
}

/// disk から既存 settings.json の `schema_version` だけを軽量に読み取る。
/// ファイル不在 / parse 失敗 / フィールド欠落はすべて `None` を返し、check_schema_compat 側で
/// 「ガード対象外」として扱う (= 旧データ / 初回保存 / 破損ファイルは save を許容する)。
async fn read_disk_schema_version(path: &std::path::Path) -> Option<u32> {
    let bytes = fs::read(path).await.ok()?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    v.get("schemaVersion").and_then(|n| n.as_u64()).map(|n| n as u32)
}

#[tauri::command]
pub async fn settings_save(app: tauri::AppHandle, settings: Settings) -> CommandResult<()> {
    let _g = SAVE_LOCK.lock().await;
    let path = crate::util::config_paths::settings_path();
    // Issue #641: 古い build が新スキーマの settings.json を silent に上書きするのを防ぐ。
    // disk の `schemaVersion` が現行 const より大きい場合、新フィールドが silent drop される
    // ため reject する (renderer 側でユーザーに「最新版に更新してください」を表示する経路)。
    let disk_v = read_disk_schema_version(&path).await;
    check_schema_compat(disk_v, settings.schema_version)?;
    let json = serde_json::to_vec_pretty(&settings)?;
    // Issue #37: 書き込み中の crash で settings.json が半端 JSON にならないよう atomic
    atomic_write(&path, &json)
        .await
        .map_err(|e| CommandError::Internal(e.to_string()))?;
    // Issue #724: mascot custom 画像 (PR #716) をユーザーが設定画面で選び直したとき、
    // assetProtocol.scope は空なので、再起動を待たず同一セッション内でその 1 ファイルを
    // `asset://` で表示できるよう asset scope へ許可する。失敗しても save 自体は成功扱い。
    //
    // PR #775 (auto-review): `statusMascotCustomPath` は renderer 由来。XSS が
    // `/etc/passwd` 等の任意パスを注入して asset scope に追加させるバイパスを防ぐため、
    // `is_allowed_mascot_path` (画像拡張子ホワイトリスト + parent ディレクトリの
    // is_safe_watch_root 検証) を通したものだけを許可する。
    if let Some(mascot_path) = settings
        .status_mascot_custom_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let p = std::path::Path::new(mascot_path);
        if crate::commands::asset_scope::is_allowed_mascot_path(p) {
            crate::commands::asset_scope::allow_asset_file(&app, p);
        } else {
            tracing::warn!(
                "[settings_save] rejected mascot path for asset scope (bad extension or unsafe directory): {}",
                p.display()
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// `Settings::default()` が renderer の `DEFAULT_SETTINGS` と camelCase で同名同値であること。
    #[test]
    fn default_settings_serializes_to_expected_camelcase_shape() {
        let s = Settings::default();
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["schemaVersion"], json!(APP_SETTINGS_SCHEMA_VERSION));
        assert_eq!(v["language"], json!("ja"));
        assert_eq!(v["theme"], json!("claude-dark"));
        assert_eq!(v["density"], json!("normal"));
        assert_eq!(v["uiFontSize"], json!(14.0));
        assert_eq!(v["editorFontSize"], json!(13.0));
        assert_eq!(v["terminalFontSize"], json!(13.0));
        assert_eq!(v["claudeCommand"], json!("claude"));
        assert_eq!(v["codexCommand"], json!("codex"));
        assert_eq!(v["claudeCodePanelWidth"], json!(460.0));
        assert_eq!(v["sidebarWidth"], json!(272.0));
        assert_eq!(v["mcpAutoSetup"], json!(true));
        assert_eq!(v["hasCompletedOnboarding"], json!(false));
        // Issue #618: Windows ConPTY UTF-8 強制 (default true)
        assert_eq!(v["terminalForceUtf8"], json!(true));
        // webviewZoom は None なので skip_serializing
        assert!(v.get("webviewZoom").is_none());
    }

    /// Issue #618: 旧 settings.json (terminalForceUtf8 フィールドなし) を load しても、
    /// `#[serde(default = "default_terminal_force_utf8")]` で `true` が入る。
    #[test]
    fn legacy_settings_without_terminal_force_utf8_default_to_true() {
        let raw = json!({
            "schemaVersion": 10,
            "language": "ja",
            "theme": "claude-dark",
            // terminalForceUtf8 を意図的に省略
        });
        let s: Settings = serde_json::from_value(raw).unwrap();
        assert!(s.terminal_force_utf8, "expected default true");
    }

    /// Issue #618: `terminalForceUtf8: false` を保存しているユーザー値はそのまま load される。
    #[test]
    fn explicit_false_terminal_force_utf8_is_preserved() {
        let raw = json!({
            "schemaVersion": 11,
            "language": "ja",
            "theme": "claude-dark",
            "terminalForceUtf8": false,
        });
        let s: Settings = serde_json::from_value(raw).unwrap();
        assert!(!s.terminal_force_utf8);
    }

    /// Issue #170 互換: 部分的な JSON でも `serde(default)` で field 単位 fallback が効く。
    #[test]
    fn partial_json_loads_with_defaults() {
        let raw = json!({
            "schemaVersion": 5,
            "theme": "dark",
            // 他は意図的に欠損
        });
        let s: Settings = serde_json::from_value(raw).unwrap();
        assert_eq!(s.schema_version, Some(5));
        assert_eq!(s.theme, "dark");
        // missing fields は default に
        assert_eq!(s.language, "ja");
        assert_eq!(s.ui_font_size, 14.0);
        assert_eq!(s.claude_command, "claude");
    }

    /// Issue #493: 旧バージョン (schemaVersion=0 / 1) からの load も deserialize 失敗しないこと。
    /// renderer 側 `migrateSettings` が古い値を新スキーマに昇格させる。
    #[test]
    fn legacy_v0_v1_settings_load_without_error() {
        let v0 = json!({
            "language": "en",
            "theme": "light",
            // schemaVersion 無し (= 旧 v0)
            "claudeCwd": "/home/user/proj",
            "recentProjects": ["/a", "/b"],
        });
        let s: Settings = serde_json::from_value(v0).unwrap();
        assert_eq!(s.schema_version, None);
        assert_eq!(s.language, "en");
        assert_eq!(s.claude_cwd, "/home/user/proj");
        assert_eq!(s.recent_projects, vec!["/a".to_string(), "/b".to_string()]);
    }

    /// 不正な型 (`claudeArgs` が number) は deserialize で reject される。
    /// Tauri IPC layer がこれを CommandError として renderer に返す経路。
    #[test]
    fn invalid_field_type_rejected_with_validation_error() {
        let bad = json!({ "claudeArgs": 12345 });
        let res: Result<Settings, _> = serde_json::from_value(bad);
        assert!(res.is_err());
    }

    /// `customAgents` の `cwd` / `color` は optional。両方欠落しても deserialize できる。
    #[test]
    fn agent_config_optional_fields() {
        let raw = json!({
            "customAgents": [
                { "id": "x", "name": "X", "command": "x", "args": "" }
            ]
        });
        let s: Settings = serde_json::from_value(raw).unwrap();
        let agents = s.custom_agents.unwrap();
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].id, "x");
        assert!(agents[0].cwd.is_none());
        assert!(agents[0].color.is_none());
    }

    /// 未知フィールドは silent に drop される (forward-compat 寄り、内部仕様)。
    /// 重要: 既知フィールドの型ミスマッチは reject、未知フィールドは無視。
    #[test]
    fn unknown_fields_are_ignored() {
        let raw = json!({
            "language": "ja",
            "futureField": "future-value"
        });
        let s: Settings = serde_json::from_value(raw).unwrap();
        assert_eq!(s.language, "ja");
        // future-value は drop される (deny_unknown_fields は使っていない)
        let back = serde_json::to_value(&s).unwrap();
        assert!(back.get("futureField").is_none());
    }

    // -------- Issue #641: schema_version 互換性ガードの単体テスト --------

    /// 同一スキーマ (= 通常運用) は accept される。
    #[test]
    fn check_schema_compat_accepts_equal_versions() {
        let r = check_schema_compat(
            Some(APP_SETTINGS_SCHEMA_VERSION),
            Some(APP_SETTINGS_SCHEMA_VERSION),
        );
        assert!(r.is_ok());
    }

    /// 旧スキーマからの save (= renderer migration が前進中 / 古い settings.json の初回 save) は
    /// accept する。renderer 側 `migrateSettings` が前進させる前提なので、Rust 側で reject すると
    /// 既存ユーザーが起動できなくなる。
    #[test]
    fn check_schema_compat_accepts_older_versions() {
        let r = check_schema_compat(Some(2), Some(2));
        assert!(r.is_ok(), "older equal schemas must be saveable");
        let r2 = check_schema_compat(Some(5), Some(APP_SETTINGS_SCHEMA_VERSION));
        assert!(r2.is_ok(), "advancing from older disk must be allowed");
    }

    /// disk が無い / `schemaVersion` フィールド欠落のときはガード対象外として accept。
    /// (初回起動 / 旧 v0 データ)
    #[test]
    fn check_schema_compat_accepts_missing_disk_version() {
        let r = check_schema_compat(None, Some(APP_SETTINGS_SCHEMA_VERSION));
        assert!(r.is_ok());
        let r2 = check_schema_compat(None, None);
        assert!(r2.is_ok());
    }

    /// disk が新スキーマで、incoming が現行 build (= 旧) のとき reject される。
    /// 旧 build が新スキーマを silent に上書きするケースを防ぐ。
    #[test]
    fn check_schema_compat_rejects_when_disk_has_newer_schema() {
        let future = APP_SETTINGS_SCHEMA_VERSION + 1;
        let r = check_schema_compat(Some(future), Some(APP_SETTINGS_SCHEMA_VERSION));
        assert!(r.is_err(), "disk newer than current build must reject");
        let msg = format!("{}", r.unwrap_err());
        assert!(
            msg.contains("newer vibe-editor"),
            "error message must hint at update: got {msg}"
        );
    }

    /// renderer から未来バージョンが渡された場合は reject。settings.json 改竄 / migration バグの保険。
    #[test]
    fn check_schema_compat_rejects_when_incoming_is_future_version() {
        let future = APP_SETTINGS_SCHEMA_VERSION + 1;
        let r = check_schema_compat(None, Some(future));
        assert!(r.is_err(), "incoming future schema must reject");
        let msg = format!("{}", r.unwrap_err());
        assert!(
            msg.contains("future schema"),
            "error message must mention future schema: got {msg}"
        );
    }

    /// `read_disk_schema_version` の挙動 sanity: 通常 JSON から正しく読める。
    #[tokio::test]
    async fn read_disk_schema_version_extracts_value() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let raw = json!({
            "schemaVersion": 42,
            "language": "ja"
        });
        tokio::fs::write(&path, serde_json::to_vec(&raw).unwrap())
            .await
            .unwrap();
        let v = read_disk_schema_version(&path).await;
        assert_eq!(v, Some(42));
    }

    /// 不在ファイル / parse 失敗 / フィールド欠落はすべて `None` を返す。
    #[tokio::test]
    async fn read_disk_schema_version_returns_none_for_missing_or_invalid() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope.json");
        assert_eq!(read_disk_schema_version(&missing).await, None);

        let invalid = dir.path().join("invalid.json");
        tokio::fs::write(&invalid, b"not-json").await.unwrap();
        assert_eq!(read_disk_schema_version(&invalid).await, None);

        let no_field = dir.path().join("no-field.json");
        tokio::fs::write(&no_field, br#"{"language":"ja"}"#).await.unwrap();
        assert_eq!(read_disk_schema_version(&no_field).await, None);
    }
}

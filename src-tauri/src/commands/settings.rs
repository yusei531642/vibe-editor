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
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::Path, time::Duration};
use tokio::fs;
use tokio::sync::Mutex;

/// Issue #37: 並列 save を直列化する。atomic_write だけでは同時 2 save で
/// どちらかが temp rename 競合して 1 つが失敗しうるが、この Mutex で書き込みを 1 つずつに。
static SAVE_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));
const SETTINGS_READ_RETRY_DELAYS: &[Duration] = &[
    Duration::from_millis(40),
    Duration::from_millis(120),
    Duration::from_millis(240),
];

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
    /// Issue #1068: codex への `team_send` 配送方式 (`"backend"` / `"pty"`)。
    /// `"backend"` (既定) は app-server JSON-RPC を優先し、ダメなら PTY 注入へ fallback。
    /// `"pty"` は常に PTY 注入。未知値 / None は `"backend"` 扱い。renderer の
    /// `CodexTeamSendDelivery` literal union と camelCase で対応。
    #[serde(default = "default_codex_team_send_delivery")]
    pub codex_team_send_delivery: String,

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
    /// Issue #825: 音声指揮モード (Voice Direction Mode, Beta) のユーザー設定。
    /// `api_key` は **入れない** (OS keyring 経由で保管、`commands::voice` の
    /// `voice_set_api_key` / `voice_has_api_key` / `voice_clear_api_key` 経由のみアクセス)。
    /// optional なので旧 settings.json (このフィールドが無い) を load しても問題ない。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice: Option<VoiceSettings>,
}

/// Issue #825: 音声指揮モード (Beta) のユーザー設定 mirror。
/// shared.ts の `VoiceSettings` と camelCase で完全一致 (`apiKey` は両側とも持たない)。
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub toggle_shortcut: Option<String>,
    /// shared.ts の literal union `'always' | 'bypass'` を String で受ける
    /// (列挙系は migration 互換性のため Rust 側で enum 化しない方針に統一)。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmation_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_shown_disclaimer: Option<bool>,
}

// VoiceSettings に `api_key` を持たない不変条件を保つため、誤って derive(Debug) で値を露出
// しないよう Debug を手書きで stub する (= 何もデバッグ情報を含まない)。将来 api_key 以外の
// 機微情報 (例: org_id) を持たせるときは、ここを更新して該当フィールドを `<REDACTED>` 化する。
impl std::fmt::Debug for VoiceSettings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VoiceSettings")
            .field("enabled", &self.enabled)
            .field("model", &self.model)
            .field("language", &self.language)
            .field("voice_name", &self.voice_name)
            // device id は機微ではないが、ハードウェア identifier なのでログ出さない
            .field(
                "input_device_id",
                &self.input_device_id.as_ref().map(|_| "<set>"),
            )
            .field(
                "output_device_id",
                &self.output_device_id.as_ref().map(|_| "<set>"),
            )
            .field("toggle_shortcut", &self.toggle_shortcut)
            .field("confirmation_mode", &self.confirmation_mode)
            .field("has_shown_disclaimer", &self.has_shown_disclaimer)
            .finish()
    }
}

/// shared.ts `AgentConfig` を mirror。API key は OS keyring に保管し、この struct には持たない。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    pub id: String,
    pub name: String,
    #[serde(default = "default_agent_runtime")]
    pub runtime: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_mode: Option<String>,
}

fn default_agent_runtime() -> String {
    "cli".to_string()
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
            codex_team_send_delivery: default_codex_team_send_delivery(),
            notepad: String::new(),
            has_completed_onboarding: Some(false),
            custom_agents: Some(Vec::new()),
            mcp_auto_setup: Some(true),
            webview_zoom: None,
            file_tree_expanded: Some(HashMap::new()),
            file_tree_collapsed_roots: Some(Vec::new()),
            terminal_force_utf8: default_terminal_force_utf8(),
            // Issue #825: voice は Beta 機能で opt-in なので default は None。
            voice: None,
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
///
/// Issue #739: 実体は `commands::schema_version` に集約した。本 re-export で旧 import パス
/// (`commands::settings::APP_SETTINGS_SCHEMA_VERSION`) は維持される。
pub use crate::commands::schema_version::SETTINGS_SCHEMA_VERSION as APP_SETTINGS_SCHEMA_VERSION;

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

/// Issue #1068: codex `team_send` 配送方式の既定。app-server 優先 (現挙動維持)。
fn default_codex_team_send_delivery() -> String {
    "backend".to_string()
}

fn default_claude_code_panel_width() -> f64 {
    460.0
}

fn default_sidebar_width() -> f64 {
    272.0
}

async fn read_optional_file_with_retry(
    path: &Path,
    label: &str,
    retry_delays: &[Duration],
) -> CommandResult<Option<Vec<u8>>> {
    for attempt in 0..=retry_delays.len() {
        match fs::read(path).await {
            Ok(bytes) => return Ok(Some(bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => {
                if let Some(delay) = retry_delays.get(attempt) {
                    tracing::warn!(
                        "[{label}] read failed at {} (attempt {}/{}): {e}; retrying in {:?}",
                        path.display(),
                        attempt + 1,
                        retry_delays.len() + 1,
                        delay
                    );
                    tokio::time::sleep(*delay).await;
                    continue;
                }
                return Err(CommandError::Io(format!(
                    "{label} read failed at {} after {} attempt(s): {e}",
                    path.display(),
                    retry_delays.len() + 1
                )));
            }
        }
    }
    unreachable!("retry loop always returns");
}

#[tauri::command]
pub async fn settings_load() -> CommandResult<Settings> {
    tracing::info!("[IPC] settings_load called");
    let path = crate::util::config_paths::settings_path();
    let settings = match read_optional_file_with_retry(
        &path,
        "settings_load",
        SETTINGS_READ_RETRY_DELAYS,
    )
    .await?
    {
        // Issue #29: 初回起動で settings.json がまだ無いときだけ default を返す。
        // Issue #905: PermissionDenied / sharing violation 等の読み取り不能は default 扱いに
        // しない。renderer 側へ Err を返し、default ベースの auto-save で原本を上書きしない。
        None => Settings::default(),
        Some(bytes) => {
            backup_pre_v12_settings_snapshot(&path, &bytes).await;
            match serde_json::from_slice::<Settings>(&bytes) {
                Ok(v) => v,
                // Issue #170 / #493 / #644 / #996: parse 失敗時の原本退避 + v11 スナップショット復旧は
                // `settings_recovery` に集約 (settings.rs の肥大化を避ける)。
                Err(e) => {
                    crate::commands::settings_recovery::recover_after_parse_failure(
                        &path, &bytes, e,
                    )
                    .await
                }
            }
        }
    };
    // Issue #1068: team_hub は永続 Settings を直接読まないため、起動時 load でミラーを同期する。
    crate::team_hub::codex_delivery::set_from_settings(Some(&settings.codex_team_send_delivery));
    Ok(settings)
}

async fn backup_pre_v12_settings_snapshot(path: &Path, bytes: &[u8]) {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(bytes) else {
        return;
    };
    let schema_version = value
        .get("schemaVersion")
        .and_then(|n| n.as_u64())
        .unwrap_or(0);
    if schema_version >= APP_SETTINGS_SCHEMA_VERSION as u64 {
        return;
    }
    let Some(parent) = path.parent() else {
        return;
    };
    let backup = parent.join("settings.v11.bak");
    if fs::try_exists(&backup).await.unwrap_or(false) {
        return;
    }
    if let Err(e) = fs::create_dir_all(parent).await {
        tracing::warn!("[settings] failed to create settings backup dir: {e}");
        return;
    }
    match fs::write(&backup, bytes).await {
        Ok(()) => tracing::info!(
            "[settings] wrote pre-v12 settings snapshot: {}",
            backup.display()
        ),
        Err(e) => tracing::warn!(
            "[settings] failed to write pre-v12 settings snapshot {}: {e}",
            backup.display()
        ),
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
///
/// Issue #739: 上記の判定ロジックは `commands::schema_version::SchemaVersion::check_compat`
/// に集約した。本関数は `settings.json` 用の `SchemaVersion` を渡す薄いラッパで、reject 条件
/// (どの version 差で弾くか) は完全に共通 helper と一致する。
pub(crate) fn check_schema_compat(
    disk_schema_version: Option<u32>,
    incoming_schema_version: Option<u32>,
) -> Result<(), CommandError> {
    crate::commands::schema_version::SchemaVersion::SETTINGS
        .check_compat(disk_schema_version, incoming_schema_version)
}

fn is_reserved_custom_agent_id(id: &str) -> bool {
    matches!(id.trim().to_ascii_lowercase().as_str(), "claude" | "codex")
}

pub(crate) fn validate_custom_agent_ids(settings: &Settings) -> Result<(), CommandError> {
    if let Some(agents) = settings.custom_agents.as_ref() {
        for agent in agents {
            if is_reserved_custom_agent_id(&agent.id) {
                return Err(CommandError::validation(format!(
                    "customAgents.id '{}' is reserved for a built-in agent",
                    agent.id
                )));
            }
        }
    }
    Ok(())
}

/// disk から既存 settings.json の `schema_version` だけを軽量に読み取る。
/// ファイル不在 / parse 失敗 / フィールド欠落はすべて `None` を返し、check_schema_compat 側で
/// 「ガード対象外」として扱う (= 旧データ / 初回保存 / 破損ファイルは save を許容する)。
async fn read_disk_schema_version(path: &std::path::Path) -> CommandResult<Option<u32>> {
    let Some(bytes) = read_optional_file_with_retry(
        path,
        "settings_save.schema_version",
        SETTINGS_READ_RETRY_DELAYS,
    )
    .await?
    else {
        return Ok(None);
    };
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return Ok(None);
    };
    Ok(v.get("schemaVersion")
        .and_then(|n| n.as_u64())
        .map(|n| n as u32))
}

#[tauri::command]
pub async fn settings_save(app: tauri::AppHandle, settings: Settings) -> CommandResult<()> {
    let _g = SAVE_LOCK.lock().await;
    let path = crate::util::config_paths::settings_path();
    // Issue #641: 古い build が新スキーマの settings.json を silent に上書きするのを防ぐ。
    // disk の `schemaVersion` が現行 const より大きい場合、新フィールドが silent drop される
    // ため reject する (renderer 側でユーザーに「最新版に更新してください」を表示する経路)。
    let disk_v = read_disk_schema_version(&path).await?;
    check_schema_compat(disk_v, settings.schema_version)?;
    validate_custom_agent_ids(&settings)?;
    let json = serde_json::to_vec_pretty(&settings)?;
    // Issue #37: 書き込み中の crash で settings.json が半端 JSON にならないよう atomic
    atomic_write(&path, &json)
        .await
        .map_err(|e| CommandError::Internal(e.to_string()))?;
    // Issue #1068: 設定変更を team_hub の配送方式ミラーへ即時反映する (settings.json が SSOT)。
    crate::team_hub::codex_delivery::set_from_settings(Some(&settings.codex_team_send_delivery));
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
        // Issue #1068: codex team_send 配送方式の既定は app-server 優先 (現挙動維持)。
        assert_eq!(v["codexTeamSendDelivery"], json!("backend"));
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

    #[test]
    fn custom_agent_reserved_ids_are_rejected() {
        let s = Settings {
            custom_agents: Some(vec![AgentConfig {
                id: "claude".into(),
                name: "Shadow Claude".into(),
                runtime: "cli".into(),
                command: "shadow".into(),
                args: "".into(),
                cwd: None,
                color: None,
                provider_id: None,
                custom_base_url: None,
                model: None,
                temperature: None,
                max_output_tokens: None,
                system_prompt: None,
                skill_ids: None,
                tool_mode: None,
            }]),
            ..Settings::default()
        };

        let err = validate_custom_agent_ids(&s).unwrap_err();
        assert!(err.to_string().contains("reserved"));
    }

    #[test]
    fn custom_agent_non_reserved_ids_are_allowed() {
        let s = Settings {
            custom_agents: Some(vec![AgentConfig {
                id: "aider".into(),
                name: "Aider".into(),
                runtime: "cli".into(),
                command: "aider".into(),
                args: "".into(),
                cwd: None,
                color: None,
                provider_id: None,
                custom_base_url: None,
                model: None,
                temperature: None,
                max_output_tokens: None,
                system_prompt: None,
                skill_ids: None,
                tool_mode: None,
            }]),
            ..Settings::default()
        };

        assert!(validate_custom_agent_ids(&s).is_ok());
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
        assert_eq!(v.unwrap(), Some(42));
    }

    /// 不在ファイル / parse 失敗 / フィールド欠落はすべて `None` を返す。
    #[tokio::test]
    async fn read_disk_schema_version_returns_none_for_missing_or_invalid() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope.json");
        assert_eq!(read_disk_schema_version(&missing).await.unwrap(), None);

        let invalid = dir.path().join("invalid.json");
        tokio::fs::write(&invalid, b"not-json").await.unwrap();
        assert_eq!(read_disk_schema_version(&invalid).await.unwrap(), None);

        let no_field = dir.path().join("no-field.json");
        tokio::fs::write(&no_field, br#"{"language":"ja"}"#)
            .await
            .unwrap();
        assert_eq!(read_disk_schema_version(&no_field).await.unwrap(), None);
    }

    #[tokio::test]
    async fn read_optional_file_with_retry_returns_none_only_for_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing.json");
        let result = read_optional_file_with_retry(&missing, "test", &[])
            .await
            .unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn read_optional_file_with_retry_rejects_non_not_found_errors() {
        let dir = tempfile::tempdir().unwrap();
        let err = read_optional_file_with_retry(dir.path(), "test", &[])
            .await
            .unwrap_err();
        assert!(
            err.to_string().contains("test read failed"),
            "unexpected error: {err}"
        );
    }

    #[tokio::test]
    async fn read_disk_schema_version_rejects_non_not_found_read_errors() {
        let dir = tempfile::tempdir().unwrap();
        let err = read_disk_schema_version(dir.path()).await.unwrap_err();
        assert!(
            err.to_string()
                .contains("settings_save.schema_version read failed"),
            "unexpected error: {err}"
        );
    }
}

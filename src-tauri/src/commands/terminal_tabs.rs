// terminal_tabs.* command — Issue #661
//
// IDE モード terminal タブの永続化。~/.vibe-editor/terminal-tabs.json を atomic write で
// 読み書きする。team-history.json とは独立した SSOT で、IDE 単独タブの cwd / cols / rows /
// Claude session id を再起動跨ぎで保持する。
//
// 設計原則:
//   - schemaVersion 一致しないファイルは読まずに `None` 返却 (= 旧データ無視で素の起動)
//   - byProject は raw projectRoot を key とし、検索/書込側で `normalize_project_root` 経由
//   - cache + LOCK で disk I/O 最小化 (team_history.rs と同流儀)

use crate::commands::schema_version::SchemaVersion;
use crate::commands::team_history::MutationResult;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::fs;
use tokio::sync::Mutex;

/// renderer 側 `TERMINAL_TABS_SCHEMA_VERSION` と一致させる
pub use crate::commands::schema_version::TERMINAL_TABS_SCHEMA_VERSION;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PersistedTerminalTab {
    pub tab_id: String,
    pub kind: String,
    pub cwd: String,
    pub cols: u32,
    pub rows: u32,
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct PersistedTerminalTabsByProject {
    pub tabs: Vec<PersistedTerminalTab>,
    pub active_tab_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PersistedTerminalTabsFile {
    pub schema_version: u32,
    pub last_saved_at: String,
    pub by_project: HashMap<String, PersistedTerminalTabsByProject>,
}

impl Default for PersistedTerminalTabsFile {
    fn default() -> Self {
        Self {
            schema_version: TERMINAL_TABS_SCHEMA_VERSION,
            last_saved_at: String::new(),
            by_project: HashMap::new(),
        }
    }
}

/// Issue #857: sanitize で drop した session の記録。renderer 側はこれを使って
/// 「復元できなかった tab」をユーザーに通知する。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DroppedSessionInfo {
    pub tab_id: String,
    pub kind: String,
    /// drop 理由。現状は transcript / rollout 不在を表す "transcript-missing" のみ。
    pub reason: String,
    /// この tab が属する project root (= by_project の key)。Issue #859 review: renderer は
    /// 現在開いている project の drop 件数だけを toast に出す必要があるため、全 project 横断の
    /// 総数で誤った件数を表示しないよう project ごとに絞り込めるようにする。
    pub project_root: String,
}

/// Issue #857: `terminal_tabs_load` の戻り値 contract。
/// `PersistedTerminalTabsFile` を `#[serde(flatten)]` で展開しつつ `droppedSessions` を追加する。
/// JSON 形: `{ schemaVersion, lastSavedAt, byProject, droppedSessions: [{tabId, kind, reason, projectRoot}] }`
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TerminalTabsLoadResult {
    #[serde(flatten)]
    pub file: PersistedTerminalTabsFile,
    pub dropped_sessions: Vec<DroppedSessionInfo>,
}

/// in-memory cache。`None` = 未ロード、`Some(...)` = ディスクと同期済み。
static CACHE: once_cell::sync::Lazy<Mutex<Option<PersistedTerminalTabsFile>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));

static LOCK: once_cell::sync::Lazy<Mutex<()>> = once_cell::sync::Lazy::new(|| Mutex::new(()));

fn store_path() -> PathBuf {
    crate::util::config_paths::terminal_tabs_path()
}

/// disk からロードする。parse 失敗時は原本 bytes を timestamped backup に退避する。
async fn load_from_disk() -> Option<PersistedTerminalTabsFile> {
    let path = store_path();
    load_from_disk_at(&path).await
}

/// disk からロードする。schemaVersion 不一致は `None` を返して旧データを無視する。
///
/// Issue #947: parse 失敗時の退避 (default に倒す前に `.bak.<ts>` へコピー) は
/// safe_load 共通基盤 (#936) に委譲する。退避規約は従来と同一で挙動等価。
/// schemaVersion チェックは terminal_tabs 固有の関心事なので従来どおりここで行う。
async fn load_from_disk_at(path: &Path) -> Option<PersistedTerminalTabsFile> {
    use crate::commands::safe_load::{safe_load_or_quarantine, LoadOutcome};
    let file = match safe_load_or_quarantine::<PersistedTerminalTabsFile>(path, Some(0o600)).await
    {
        LoadOutcome::Loaded(f) => f,
        LoadOutcome::Absent | LoadOutcome::Corrupted => return None,
    };
    if file.schema_version != TERMINAL_TABS_SCHEMA_VERSION {
        tracing::info!(
            "[terminal_tabs] schemaVersion mismatch (file={}, current={}), ignoring",
            file.schema_version,
            TERMINAL_TABS_SCHEMA_VERSION
        );
        return None;
    }
    Some(file)
}

async fn ensure_loaded(cache: &mut Option<PersistedTerminalTabsFile>) {
    if cache.is_some() {
        return;
    }
    *cache = Some(load_from_disk().await.unwrap_or_default());
}

/// Issue #702: cwd + session_id から `~/.claude/projects/<encoded(cwd)>/<session_id>.jsonl` を構築する。
/// `home` は通常 `dirs::home_dir()`。テスト用に切り出して mock 可能にしてある。
/// encoding 規則は `pty::path_norm::encode_project_path` (= claude_watcher.rs と同じ) を共有する。
fn claude_jsonl_path(home: &Path, cwd: &str, session_id: &str) -> PathBuf {
    home.join(".claude")
        .join("projects")
        .join(crate::pty::path_norm::encode_project_path(cwd))
        .join(format!("{session_id}.jsonl"))
}

/// Issue #857 / #859 (perf): `<sessions_root>` 配下の `rollout-*.jsonl` の file_stem を
/// **1 回の再帰走査で** すべて集める。codex tab が複数あっても walk は 1 度だけにして、起動時
/// sanitize の「tab ごとに full 再帰走査 = O(N×M)」を「O(M) walk + O(N×M) の in-memory 突合」
/// に落とす。
fn collect_codex_rollout_stems(sessions_root: &Path) -> Vec<String> {
    fn walk(dir: &Path, out: &mut Vec<String>) {
        let read = match std::fs::read_dir(dir) {
            Ok(r) => r,
            Err(_) => return,
        };
        for entry in read.flatten() {
            let path = entry.path();
            match entry.file_type() {
                Ok(ft) if ft.is_dir() => walk(&path, out),
                Ok(_) => {
                    if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                        continue;
                    }
                    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                        if stem.starts_with("rollout-") {
                            out.push(stem.to_string());
                        }
                    }
                }
                _ => {}
            }
        }
    }
    let mut out = Vec::new();
    walk(sessions_root, &mut out);
    out
}

/// 収集済み stem 群から session_id 一致 (stem 末尾が `-<session_id>` = `rollout-<ts>-<sid>`) を
/// 判定する in-memory ヘルパー。空 id は常に false。
fn codex_rollout_stem_matches(stems: &[String], session_id: &str) -> bool {
    if session_id.is_empty() {
        return false;
    }
    let suffix = format!("-{session_id}");
    stems.iter().any(|s| s.ends_with(&suffix))
}

/// 単発の存在確認 (主に test 用)。1 度 walk して suffix 一致を見る。
#[cfg(test)]
fn codex_rollout_exists_sync(sessions_root: &Path, session_id: &str) -> bool {
    codex_rollout_stem_matches(&collect_codex_rollout_stems(sessions_root), session_id)
}

/// Issue #702 / #857: 復元データ内の sessionId を sanitize する。
/// transcript / rollout が存在しない sessionId を None に倒し、drop した tab を
/// `Vec<DroppedSessionInfo>` (reason="transcript-missing") に収集して返す。
///
/// - `kind == "claude"`: `~/.claude/projects/<encoded(cwd)>/<sid>.jsonl` 不在で drop。
/// - `kind == "codex"` (#857): `<codex_sessions_root>` 配下に `rollout-*-<sid>.jsonl` 不在で drop。
///
/// 背景: PR #663 (Issue #660/#661/#662) で IDE モードの terminal タブを永続化したが、
/// 記録された sessionId に対応する transcript が無いケースがある:
///   - ユーザーが prompt を 1 件も送らずに閉じた → transcript が作られないまま終了
///   - `~/.claude/projects/` や `~/.codex/sessions/` を手動削除 / 別マシン環境移行
///   - cwd が変わって encoded path が別ディレクトリを指す (claude)
///
/// このまま `--resume <存在しない id>` で起動すると CLI が
/// `No conversation found ...` を出して exitCode=1 で死ぬ。renderer 側は sessionId が None なら
/// resume を渡さず新規 id 採番経路に倒す。`droppedSessions` は UI 通知用。
async fn sanitize_missing_jsonl(
    file: &mut PersistedTerminalTabsFile,
    home: &Path,
    codex_sessions_root: &Path,
) -> Vec<DroppedSessionInfo> {
    let mut dropped = Vec::new();

    // Issue #859 (perf): codex tab が 1 つでも存在するなら rollout stem を **1 回だけ** 収集する。
    // 以前は tab ごとに full 再帰走査して O(N×M) だったが、1 回 walk + in-memory 突合に落とす。
    // 再帰走査は blocking なので spawn_blocking で executor を塞がない。
    let has_codex_session = file.by_project.values().any(|slot| {
        slot.tabs
            .iter()
            .any(|t| t.kind == "codex" && t.session_id.is_some())
    });
    let codex_stems: Vec<String> = if has_codex_session {
        let root = codex_sessions_root.to_path_buf();
        tokio::task::spawn_blocking(move || collect_codex_rollout_stems(&root))
            .await
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    for (project_root, slot) in file.by_project.iter_mut() {
        for tab in slot.tabs.iter_mut() {
            let Some(sid) = tab.session_id.as_deref() else {
                continue;
            };
            let missing = match tab.kind.as_str() {
                "claude" => {
                    let path = claude_jsonl_path(home, &tab.cwd, sid);
                    fs::metadata(&path).await.is_err()
                }
                "codex" => !codex_rollout_stem_matches(&codex_stems, sid),
                // 未知 kind は sanitize 対象外 (session_id 温存)。
                _ => continue,
            };
            if missing {
                tracing::info!(
                    "[terminal_tabs] session transcript missing for tab={} kind={} sid={} cwd={}, dropping sessionId",
                    tab.tab_id,
                    tab.kind,
                    sid,
                    tab.cwd
                );
                dropped.push(DroppedSessionInfo {
                    tab_id: tab.tab_id.clone(),
                    kind: tab.kind.clone(),
                    reason: "transcript-missing".to_string(),
                    project_root: project_root.clone(),
                });
                tab.session_id = None;
            }
        }
    }
    dropped
}

/// disk にある `schemaVersion` だけを軽量に読む。
///
/// ファイル不在 / parse 失敗 / フィールド欠落は `None` として扱う。parse 失敗は
/// `load_from_disk_at` 側で backup 済みの想定なので、save guard では未来 schema の検出に集中する。
async fn read_disk_schema_version(path: &Path) -> Result<Option<u32>, String> {
    let bytes = match fs::read(path).await {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return Ok(None);
    };
    Ok(value
        .get("schemaVersion")
        .and_then(|n| n.as_u64())
        .map(|n| n as u32))
}

async fn save_to_disk(file: &PersistedTerminalTabsFile) -> Result<(), String> {
    let path = store_path();
    save_to_disk_at(&path, file).await
}

async fn save_to_disk_at(path: &Path, file: &PersistedTerminalTabsFile) -> Result<(), String> {
    let disk_schema_version = read_disk_schema_version(path).await?;
    SchemaVersion::TERMINAL_TABS
        .check_compat(disk_schema_version, Some(file.schema_version))
        .map_err(|e| e.to_string())?;
    let json = serde_json::to_vec_pretty(file).map_err(|e| e.to_string())?;
    // Issue #608: terminal-tabs.json は Claude session id (UUID) と cwd を持ち、漏洩すると
    // `~/.claude/projects/<encoded>/<uuid>.jsonl` の会話履歴に間接アクセスできるため
    // 機密ファイル扱い。`~/.claude.json` / role-profiles 等と同じく 0o600 を強制する。
    // Windows では mode は no-op (Windows ACL 強制は別 issue で対応)。
    crate::commands::atomic_write::atomic_write_with_mode(path, &json, Some(0o600))
        .await
        .map_err(|e| e.to_string())
}

/// load: 永続化ファイルが空 / 未存在 / schemaVersion 不一致なら `None` 返却。
/// renderer 側はこれで「素の IDE モード起動」と判定して順序復元をスキップする。
///
/// Issue #702 / #857: 戻り値は `sanitize_missing_jsonl` で post-process し、transcript 不在の
/// sessionId を None に倒したうえで `droppedSessions` に drop 一覧を載せて返す。cache 自体には
/// 触らない (= 次回 load でも同じ check が走る、idempotent。renderer 側 save が走るまで disk 上の
/// sessionId はそのまま温存され、例えばユーザーが claude/codex を直接起動して同じ sessionId の
/// transcript を作れば次回 load で復活できる)。
#[tauri::command]
pub async fn terminal_tabs_load() -> Option<TerminalTabsLoadResult> {
    let _g = LOCK.lock().await;
    let mut cache = CACHE.lock().await;
    ensure_loaded(&mut cache).await;
    let file = cache.as_ref().expect("ensured");
    if file.by_project.is_empty() && file.last_saved_at.is_empty() {
        return None;
    }
    let mut sanitized = file.clone();
    let home = dirs::home_dir().unwrap_or_default();
    let codex_sessions_root = crate::pty::codex_watcher::codex_sessions_dir();
    let dropped_sessions =
        sanitize_missing_jsonl(&mut sanitized, &home, &codex_sessions_root).await;
    Some(TerminalTabsLoadResult {
        file: sanitized,
        dropped_sessions,
    })
}

/// save: renderer から渡された全体を atomic 上書き。
/// renderer 側 hook が「他プロジェクト entry 保持 + 自分の entry 更新」を行う read-modify-write
/// なので、ここは渡された file をそのまま採用する (= cache 更新 + disk write)。
#[tauri::command]
pub async fn terminal_tabs_save(file: PersistedTerminalTabsFile) -> MutationResult {
    let _g = LOCK.lock().await;
    let mut cache = CACHE.lock().await;
    match save_to_disk(&file).await {
        Ok(()) => {
            *cache = Some(file);
            MutationResult {
                ok: true,
                error: None,
                ..Default::default()
            }
        }
        Err(e) => MutationResult {
            ok: false,
            error: Some(e),
            ..Default::default()
        },
    }
}

/// clear: ファイル削除 + cache を空に戻す。設定からの「タブ復元を全消去」操作などで使う。
/// 既に存在しないときも `ok=true` を返す (idempotent)。
#[tauri::command]
pub async fn terminal_tabs_clear() -> MutationResult {
    let _g = LOCK.lock().await;
    let mut cache = CACHE.lock().await;
    let path = store_path();
    *cache = Some(PersistedTerminalTabsFile::default());
    match fs::remove_file(&path).await {
        Ok(()) => MutationResult {
            ok: true,
            error: None,
            ..Default::default()
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => MutationResult {
            ok: true,
            error: None,
            ..Default::default()
        },
        Err(e) => MutationResult {
            ok: false,
            error: Some(e.to_string()),
            ..Default::default()
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_tab(id: &str) -> PersistedTerminalTab {
        PersistedTerminalTab {
            tab_id: id.to_string(),
            kind: "claude".to_string(),
            cwd: "/tmp/repo".to_string(),
            cols: 100,
            rows: 30,
            session_id: Some("11111111-2222-3333-4444-555555555555".to_string()),
            label: None,
            team_id: None,
            agent_id: None,
            role: None,
        }
    }

    #[test]
    fn schema_version_constant_matches_default_file() {
        let f = PersistedTerminalTabsFile::default();
        assert_eq!(f.schema_version, TERMINAL_TABS_SCHEMA_VERSION);
        assert!(f.by_project.is_empty());
    }

    #[tokio::test]
    async fn load_from_disk_backs_up_invalid_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("terminal-tabs.json");
        let corrupt = b"{ not valid json";
        fs::write(&path, corrupt).await.unwrap();

        let loaded = load_from_disk_at(&path).await;

        assert!(loaded.is_none(), "invalid JSON should load as missing");
        let mut backups = Vec::new();
        let mut entries = fs::read_dir(dir.path()).await.unwrap();
        while let Some(entry) = entries.next_entry().await.unwrap() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("terminal-tabs.json.bak.") {
                backups.push(entry.path());
            }
        }
        assert_eq!(backups.len(), 1, "exactly one backup should be written");
        let backup_bytes = fs::read(&backups[0]).await.unwrap();
        assert_eq!(backup_bytes, corrupt);
    }

    #[tokio::test]
    async fn save_to_disk_rejects_future_disk_schema_without_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("terminal-tabs.json");
        let original = format!(
            r#"{{"schemaVersion":{},"lastSavedAt":"future","byProject":{{"keep":{{"tabs":[],"activeTabId":null}}}}}}"#,
            TERMINAL_TABS_SCHEMA_VERSION + 1
        );
        fs::write(&path, original.as_bytes()).await.unwrap();

        let err = save_to_disk_at(&path, &PersistedTerminalTabsFile::default())
            .await
            .unwrap_err();

        assert!(
            err.contains("newer vibe-editor"),
            "error should explain update requirement: {err}"
        );
        let after = fs::read_to_string(&path).await.unwrap();
        assert_eq!(
            after, original,
            "future schema file must not be overwritten"
        );
    }

    #[tokio::test]
    async fn save_to_disk_rejects_future_incoming_schema() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("terminal-tabs.json");
        let file = PersistedTerminalTabsFile {
            schema_version: TERMINAL_TABS_SCHEMA_VERSION + 1,
            ..Default::default()
        };

        let err = save_to_disk_at(&path, &file).await.unwrap_err();

        assert!(
            err.contains("future schema"),
            "error should mention future schema: {err}"
        );
        assert!(
            !path.exists(),
            "rejected future incoming schema should not create a file"
        );
    }

    #[test]
    fn round_trip_serde_preserves_fields() {
        let mut by_project = HashMap::new();
        by_project.insert(
            "C:\\repo".to_string(),
            PersistedTerminalTabsByProject {
                tabs: vec![sample_tab("1"), sample_tab("2")],
                active_tab_id: Some("1".to_string()),
            },
        );
        let file = PersistedTerminalTabsFile {
            schema_version: TERMINAL_TABS_SCHEMA_VERSION,
            last_saved_at: "2026-05-09T00:00:00Z".to_string(),
            by_project,
        };
        let json = serde_json::to_string(&file).unwrap();
        // camelCase 確認 (snake_case が漏れていないこと)
        assert!(json.contains("\"schemaVersion\""));
        assert!(json.contains("\"byProject\""));
        assert!(json.contains("\"activeTabId\""));
        assert!(json.contains("\"tabId\""));
        assert!(json.contains("\"sessionId\""));
        let restored: PersistedTerminalTabsFile = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.schema_version, TERMINAL_TABS_SCHEMA_VERSION);
        assert_eq!(restored.by_project.len(), 1);
        assert_eq!(restored.by_project["C:\\repo"].tabs.len(), 2);
        assert_eq!(
            restored.by_project["C:\\repo"].active_tab_id.as_deref(),
            Some("1")
        );
    }

    #[test]
    fn missing_optional_fields_default_to_none() {
        let json = r#"{
            "schemaVersion": 1,
            "lastSavedAt": "",
            "byProject": {
                "/tmp/r": {
                    "tabs": [{
                        "tabId": "1",
                        "kind": "claude",
                        "cwd": "/tmp/r",
                        "cols": 80,
                        "rows": 24,
                        "sessionId": null
                    }],
                    "activeTabId": null
                }
            }
        }"#;
        let file: PersistedTerminalTabsFile = serde_json::from_str(json).unwrap();
        let tab = &file.by_project["/tmp/r"].tabs[0];
        assert!(tab.label.is_none());
        assert!(tab.team_id.is_none());
        assert!(tab.agent_id.is_none());
        assert!(tab.role.is_none());
    }

    // ---- Issue #702: sanitize_missing_jsonl tests ----

    fn unique_temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vibe-editor-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn make_file_with_tab(kind: &str, cwd: &str, sid: Option<&str>) -> PersistedTerminalTabsFile {
        let mut by_project = HashMap::new();
        by_project.insert(
            cwd.to_string(),
            PersistedTerminalTabsByProject {
                tabs: vec![PersistedTerminalTab {
                    tab_id: "1".to_string(),
                    kind: kind.to_string(),
                    cwd: cwd.to_string(),
                    cols: 80,
                    rows: 24,
                    session_id: sid.map(String::from),
                    label: None,
                    team_id: None,
                    agent_id: None,
                    role: None,
                }],
                active_tab_id: None,
            },
        );
        PersistedTerminalTabsFile {
            schema_version: TERMINAL_TABS_SCHEMA_VERSION,
            last_saved_at: "2026-05-10T00:00:00Z".to_string(),
            by_project,
        }
    }

    fn write_jsonl(home: &Path, cwd: &str, sid: &str) {
        let dir = home
            .join(".claude")
            .join("projects")
            .join(crate::pty::path_norm::encode_project_path(cwd));
        std::fs::create_dir_all(&dir).expect("create projects dir");
        std::fs::write(dir.join(format!("{sid}.jsonl")), "{}\n").expect("write jsonl");
    }

    /// テスト用の codex sessions root (`<base>/.codex/sessions`)。本番の
    /// `codex_watcher::codex_sessions_dir()` と同じレイアウトを temp 配下に再現する。
    fn codex_sessions_root_in(base: &Path) -> PathBuf {
        base.join(".codex").join("sessions")
    }

    /// 日付サブディレクトリ配下に `rollout-<ts>-<sid>.jsonl` を作る。
    fn write_codex_rollout(sessions_root: &Path, sid: &str) {
        let day = sessions_root.join("2026").join("05").join("31");
        std::fs::create_dir_all(&day).expect("create codex day dir");
        std::fs::write(
            day.join(format!("rollout-2026-05-31T00-00-00-{sid}.jsonl")),
            "{\"type\":\"session_meta\"}\n",
        )
        .expect("write codex rollout");
    }

    #[tokio::test]
    async fn sanitize_drops_session_id_when_jsonl_missing() {
        let tmp = unique_temp_dir("terminal-tabs-sanitize-missing");
        let cwd = "/tmp/repo";
        let sid = "11111111-2222-3333-4444-555555555555";
        // jsonl は意図的に作らない
        let mut file = make_file_with_tab("claude", cwd, Some(sid));
        let dropped = sanitize_missing_jsonl(&mut file, &tmp, &codex_sessions_root_in(&tmp)).await;
        assert!(
            file.by_project[cwd].tabs[0].session_id.is_none(),
            "missing jsonl should drop sessionId"
        );
        assert_eq!(dropped.len(), 1, "dropped session should be recorded");
        assert_eq!(dropped[0].tab_id, "1");
        assert_eq!(dropped[0].kind, "claude");
        assert_eq!(dropped[0].reason, "transcript-missing");
        let _ = std::fs::remove_dir_all(tmp);
    }

    #[tokio::test]
    async fn sanitize_keeps_session_id_when_jsonl_exists() {
        let tmp = unique_temp_dir("terminal-tabs-sanitize-exists");
        let cwd = "/tmp/some-repo";
        let sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        write_jsonl(&tmp, cwd, sid);

        let mut file = make_file_with_tab("claude", cwd, Some(sid));
        let dropped = sanitize_missing_jsonl(&mut file, &tmp, &codex_sessions_root_in(&tmp)).await;
        assert_eq!(
            file.by_project[cwd].tabs[0].session_id.as_deref(),
            Some(sid),
            "existing jsonl should keep sessionId"
        );
        assert!(dropped.is_empty(), "no drop when jsonl exists");
        let _ = std::fs::remove_dir_all(tmp);
    }

    /// Issue #857: codex tab の rollout が存在すれば sessionId は維持される。
    /// (旧 `sanitize_skips_non_claude_tabs` の置き換え — codex は skip ではなく rollout 検証対象)
    #[tokio::test]
    async fn sanitize_keeps_codex_session_id_when_rollout_exists() {
        let tmp = unique_temp_dir("terminal-tabs-sanitize-codex-exists");
        let cwd = "/tmp/repo-codex";
        let sid = "cccccccc-dddd-eeee-ffff-000000000000";
        let codex_root = codex_sessions_root_in(&tmp);
        write_codex_rollout(&codex_root, sid);

        let mut file = make_file_with_tab("codex", cwd, Some(sid));
        let dropped = sanitize_missing_jsonl(&mut file, &tmp, &codex_root).await;
        assert_eq!(
            file.by_project[cwd].tabs[0].session_id.as_deref(),
            Some(sid),
            "codex sessionId kept when rollout exists"
        );
        assert!(dropped.is_empty(), "no drop when rollout exists");
        let _ = std::fs::remove_dir_all(tmp);
    }

    /// Issue #857: codex tab の rollout が不在なら sessionId を drop し記録する。
    #[tokio::test]
    async fn sanitize_drops_codex_session_id_when_rollout_missing() {
        let tmp = unique_temp_dir("terminal-tabs-sanitize-codex-missing");
        let cwd = "/tmp/repo-codex-missing";
        let sid = "deadbeef-dddd-eeee-ffff-000000000000";
        // rollout は意図的に作らない (codex sessions root も存在しない)
        let codex_root = codex_sessions_root_in(&tmp);

        let mut file = make_file_with_tab("codex", cwd, Some(sid));
        let dropped = sanitize_missing_jsonl(&mut file, &tmp, &codex_root).await;
        assert!(
            file.by_project[cwd].tabs[0].session_id.is_none(),
            "missing codex rollout should drop sessionId"
        );
        assert_eq!(dropped.len(), 1);
        assert_eq!(dropped[0].kind, "codex");
        assert_eq!(dropped[0].reason, "transcript-missing");
        let _ = std::fs::remove_dir_all(tmp);
    }

    #[tokio::test]
    async fn sanitize_handles_null_session_id() {
        let tmp = unique_temp_dir("terminal-tabs-sanitize-null");
        let cwd = "/tmp/repo-null";
        let mut file = make_file_with_tab("claude", cwd, None);
        let dropped = sanitize_missing_jsonl(&mut file, &tmp, &codex_sessions_root_in(&tmp)).await;
        assert!(file.by_project[cwd].tabs[0].session_id.is_none());
        assert!(dropped.is_empty());
        let _ = std::fs::remove_dir_all(tmp);
    }

    /// `codex_rollout_exists_sync` の最小単体: stem 末尾が `-<sid>` の rollout を見つける/弾く。
    #[test]
    fn codex_rollout_exists_matches_by_session_id_suffix() {
        let tmp = unique_temp_dir("terminal-tabs-codex-rollout-lookup");
        let root = codex_sessions_root_in(&tmp);
        let sid = "11112222-3333-4444-5555-666677778888";
        write_codex_rollout(&root, sid);

        assert!(
            codex_rollout_exists_sync(&root, sid),
            "should find rollout by sid suffix"
        );
        assert!(
            !codex_rollout_exists_sync(&root, "no-such-id"),
            "unknown sid must not match"
        );
        assert!(
            !codex_rollout_exists_sync(&root, ""),
            "empty sid never matches"
        );
        let _ = std::fs::remove_dir_all(tmp);
    }

    /// Issue #857: 戻り値 contract (camelCase + droppedSessions) を固定する。
    #[test]
    fn load_result_serializes_to_expected_camelcase_contract() {
        let result = TerminalTabsLoadResult {
            file: PersistedTerminalTabsFile {
                schema_version: TERMINAL_TABS_SCHEMA_VERSION,
                last_saved_at: "2026-05-31T00:00:00Z".to_string(),
                by_project: HashMap::new(),
            },
            dropped_sessions: vec![DroppedSessionInfo {
                tab_id: "tab-1".to_string(),
                kind: "codex".to_string(),
                reason: "transcript-missing".to_string(),
                project_root: "/tmp/proj".to_string(),
            }],
        };
        let json = serde_json::to_string(&result).unwrap();
        // flatten で従来フィールドはそのまま + droppedSessions 追加
        assert!(json.contains("\"schemaVersion\""));
        assert!(json.contains("\"lastSavedAt\""));
        assert!(json.contains("\"byProject\""));
        assert!(json.contains("\"droppedSessions\""));
        assert!(json.contains("\"tabId\":\"tab-1\""));
        assert!(json.contains("\"reason\":\"transcript-missing\""));
        assert!(json.contains("\"projectRoot\":\"/tmp/proj\""));
        // snake_case が漏れていないこと
        assert!(!json.contains("dropped_sessions"));
        assert!(!json.contains("tab_id"));
        assert!(!json.contains("project_root"));

        // round-trip
        let restored: TerminalTabsLoadResult = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.dropped_sessions.len(), 1);
        assert_eq!(restored.dropped_sessions[0].tab_id, "tab-1");
        assert_eq!(restored.file.schema_version, TERMINAL_TABS_SCHEMA_VERSION);
    }

    #[tokio::test]
    async fn sanitize_processes_each_tab_independently() {
        let tmp = unique_temp_dir("terminal-tabs-sanitize-mixed");
        let cwd = "/tmp/mixed";
        let sid_alive = "alive-aaaa-bbbb-cccc-dddddddddddd";
        let sid_dead = "dead-aaaa-bbbb-cccc-dddddddddddd";
        write_jsonl(&tmp, cwd, sid_alive);

        let mut by_project = HashMap::new();
        by_project.insert(
            cwd.to_string(),
            PersistedTerminalTabsByProject {
                tabs: vec![
                    PersistedTerminalTab {
                        tab_id: "1".to_string(),
                        kind: "claude".to_string(),
                        cwd: cwd.to_string(),
                        cols: 80,
                        rows: 24,
                        session_id: Some(sid_alive.to_string()),
                        label: None,
                        team_id: None,
                        agent_id: None,
                        role: None,
                    },
                    PersistedTerminalTab {
                        tab_id: "2".to_string(),
                        kind: "claude".to_string(),
                        cwd: cwd.to_string(),
                        cols: 80,
                        rows: 24,
                        session_id: Some(sid_dead.to_string()),
                        label: None,
                        team_id: None,
                        agent_id: None,
                        role: None,
                    },
                ],
                active_tab_id: None,
            },
        );
        let mut file = PersistedTerminalTabsFile {
            schema_version: TERMINAL_TABS_SCHEMA_VERSION,
            last_saved_at: "2026-05-10T00:00:00Z".to_string(),
            by_project,
        };
        let dropped = sanitize_missing_jsonl(&mut file, &tmp, &codex_sessions_root_in(&tmp)).await;

        let tabs = &file.by_project[cwd].tabs;
        assert_eq!(
            tabs[0].session_id.as_deref(),
            Some(sid_alive),
            "alive sid kept"
        );
        assert!(tabs[1].session_id.is_none(), "dead sid dropped");
        assert_eq!(dropped.len(), 1, "only the dead tab is recorded");
        assert_eq!(dropped[0].tab_id, "2");

        let _ = std::fs::remove_dir_all(tmp);
    }
}

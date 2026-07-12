//! Issue #1193: project root の authority を renderer の生文字列から分離する。
//!
//! `settings.json` は renderer が更新できる表示設定であり、project root を認可してはならない。
//! 本モジュールは native picker で選ばれた directory の canonical path と filesystem identity
//! だけを private ledger に記録し、active / workspace root の唯一の権限源にする。

use crate::commands::atomic_write::atomic_write_with_mode;
use crate::commands::error::{CommandError, CommandResult};
use crate::state::AppState;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

const PROJECT_AUTHORITY_SCHEMA_VERSION: u8 = 1;

static LEDGER_WRITE_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

/// directory を path の表記ではなく filesystem object として識別する snapshot。
///
/// これにより、同じpathが別directoryへ置換された場合や symlink の参照先が変わった場合を
/// fail-closed に検知する。各フィールドは ledger の wire format であり、renderer 入力は使わない。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRootIdentity {
    pub version: u8,
    pub canonical_root: String,
    pub platform_file_id: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectAuthorityLedger {
    #[serde(default)]
    schema_version: u8,
    #[serde(default)]
    active: Option<ProjectRootIdentity>,
    #[serde(default)]
    workspace_roots: Vec<ProjectRootIdentity>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedProjectFile {
    pub project_root: String,
    pub file_path: String,
}

fn authority_path() -> PathBuf {
    crate::util::config_paths::project_authority_path()
}

fn canonical_root_key(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    let stripped = normalized.trim_end_matches('/');
    let normalized = if stripped.is_empty() && normalized.starts_with('/') {
        "/"
    } else {
        stripped
    };
    if cfg!(windows) {
        normalized.to_lowercase()
    } else {
        normalized.to_string()
    }
}

#[cfg(unix)]
fn platform_file_id(path: &Path) -> Result<String, CommandError> {
    use std::os::unix::fs::MetadataExt;

    let metadata = std::fs::metadata(path)
        .map_err(|error| CommandError::authz(format!("metadata project root failed: {error}")))?;
    Ok(format!("unix:{}:{}", metadata.dev(), metadata.ino()))
}

#[cfg(windows)]
fn platform_file_id(path: &Path) -> Result<String, CommandError> {
    use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS,
    };

    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .map_err(|error| CommandError::authz(format!("open project root failed: {error}")))?;
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    let ok = unsafe {
        GetFileInformationByHandle(file.as_raw_handle() as _, std::ptr::addr_of_mut!(info))
    };
    if ok == 0 {
        return Err(CommandError::authz(format!(
            "GetFileInformationByHandle project root failed: {}",
            std::io::Error::last_os_error()
        )));
    }
    let file_index = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
    Ok(format!(
        "windows:{}:{file_index}",
        info.dwVolumeSerialNumber
    ))
}

#[cfg(not(any(unix, windows)))]
fn platform_file_id(_path: &Path) -> Result<String, CommandError> {
    Err(CommandError::authz(
        "project filesystem identity is unsupported on this platform",
    ))
}

/// canonicalize と identity取得の間に root が差し替えられていないことを二重snapshotで確認する。
/// directory が継続的に変化している場合は推測せず fail-closed にする。
fn capture_identity_blocking(candidate: PathBuf) -> CommandResult<ProjectRootIdentity> {
    if !crate::commands::fs_watch::is_safe_watch_root(&candidate) {
        return Err(CommandError::validation(
            "project root rejected by safety check (system / home / non-existent dir)",
        ));
    }

    for _ in 0..3 {
        let first = std::fs::canonicalize(&candidate).map_err(|error| {
            CommandError::authz(format!("canonicalize project root failed: {error}"))
        })?;
        let first_id = platform_file_id(&first)?;
        let second = std::fs::canonicalize(&candidate).map_err(|error| {
            CommandError::authz(format!("canonicalize project root failed: {error}"))
        })?;
        let second_id = platform_file_id(&second)?;
        if first == second && first_id == second_id {
            return Ok(ProjectRootIdentity {
                version: PROJECT_AUTHORITY_SCHEMA_VERSION,
                canonical_root: canonical_root_key(&second),
                platform_file_id: second_id,
            });
        }
    }

    Err(CommandError::authz(
        "project root changed while its identity was being verified",
    ))
}

pub async fn capture_identity(candidate: impl Into<PathBuf>) -> CommandResult<ProjectRootIdentity> {
    let candidate = candidate.into();
    tokio::task::spawn_blocking(move || capture_identity_blocking(candidate))
        .await
        .map_err(|error| CommandError::internal(format!("project identity task failed: {error}")))?
}

pub async fn verify_identity(identity: &ProjectRootIdentity) -> CommandResult<()> {
    if identity.version != PROJECT_AUTHORITY_SCHEMA_VERSION
        || identity.canonical_root.trim().is_empty()
        || identity.platform_file_id.trim().is_empty()
    {
        return Err(CommandError::authz("invalid stored project root authority"));
    }
    let current = capture_identity(identity.canonical_root.clone()).await?;
    if &current != identity {
        return Err(CommandError::authz(
            "project root identity no longer matches its native approval",
        ));
    }
    Ok(())
}

async fn load_ledger_from(path: &Path) -> CommandResult<ProjectAuthorityLedger> {
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ProjectAuthorityLedger {
                schema_version: PROJECT_AUTHORITY_SCHEMA_VERSION,
                ..ProjectAuthorityLedger::default()
            });
        }
        Err(error) => {
            return Err(CommandError::Io(format!(
                "read project authority failed: {error}"
            )))
        }
    };
    let ledger: ProjectAuthorityLedger = serde_json::from_slice(&bytes)
        .map_err(|error| CommandError::Parse(format!("parse project authority failed: {error}")))?;
    if ledger.schema_version != PROJECT_AUTHORITY_SCHEMA_VERSION {
        return Err(CommandError::authz(
            "project authority schema is unsupported; choose the project again",
        ));
    }
    Ok(ledger)
}

async fn write_ledger_to(path: &Path, ledger: &ProjectAuthorityLedger) -> CommandResult<()> {
    let bytes = serde_json::to_vec_pretty(ledger).map_err(|error| {
        CommandError::Parse(format!("serialize project authority failed: {error}"))
    })?;
    atomic_write_with_mode(path, &bytes, Some(0o600))
        .await
        .map_err(|error| CommandError::Io(format!("write project authority failed: {error}")))
}

async fn load_ledger() -> CommandResult<ProjectAuthorityLedger> {
    load_ledger_from(&authority_path()).await
}

async fn write_ledger(ledger: &ProjectAuthorityLedger) -> CommandResult<()> {
    write_ledger_to(&authority_path(), ledger).await
}

/// identity確認済みrootだけを runtime state / watcher / asset scope に反映する唯一の commit 点。
fn activate_verified_root(app: &AppHandle, state: &AppState, identity: &ProjectRootIdentity) {
    crate::state::set_project_root_authority(
        &state.project_root,
        &state.project_root_identity,
        Some(identity.clone()),
    );
    // Issue #1193: Tauri asset scope は追加のみで旧rootをrevokeできない。画像previewは
    // files_read_image（active/workspace authz済みdata URL）へ移したため、project directoryを
    // global asset:// allowlistへ追加しない。
    crate::commands::fs_watch::start_for_root(app.clone(), identity.canonical_root.clone());
}

async fn persist_and_activate(
    app: &AppHandle,
    state: &AppState,
    identity: ProjectRootIdentity,
) -> CommandResult<String> {
    // 保存前と直前の二度検証。失敗時は旧state / ledgerを維持する。
    verify_identity(&identity).await?;
    let _guard = LEDGER_WRITE_LOCK.lock().await;
    let previous = load_ledger().await?;
    let mut next = previous.clone();
    next.active = Some(identity.clone());
    write_ledger(&next).await?;
    if let Err(error) = verify_identity(&identity).await {
        write_ledger(&previous).await.map_err(|rollback_error| {
            CommandError::internal(format!(
                "project activation failed ({error}); authority rollback also failed: {rollback_error}"
            ))
        })?;
        return Err(error);
    }
    activate_verified_root(app, state, &identity);
    Ok(identity.canonical_root)
}

/// native folder picker の選択結果だけでactive rootを切り替える公開IPC。
/// raw pathを引数に受けないため、侵害rendererは任意pathをauthorityへ昇格できない。
#[tauri::command]
pub async fn app_pick_and_activate_project_root(
    app: AppHandle,
    state: State<'_, AppState>,
    title: Option<String>,
) -> CommandResult<Option<String>> {
    let Some(selected) = crate::commands::dialog::pick_folder(&app, title).await else {
        return Ok(None);
    };
    let identity = capture_identity(selected).await?;
    persist_and_activate(&app, &state, identity).await.map(Some)
}

/// recent project は表示履歴にすぎないためraw pathを直接active化しない。履歴pathはnative
/// pickerの初期directoryにだけ使い、ユーザーが再選択した結果を同じauthority transactionで
/// 検証・永続化する。
#[tauri::command]
pub async fn app_reconfirm_project_root(
    app: AppHandle,
    state: State<'_, AppState>,
    initial_root: String,
    title: Option<String>,
) -> CommandResult<Option<String>> {
    let Some(selected) =
        crate::commands::dialog::pick_folder_starting_at(&app, title, Some(initial_root)).await
    else {
        return Ok(None);
    };
    let identity = capture_identity(selected).await?;
    persist_and_activate(&app, &state, identity).await.map(Some)
}

/// native file pickerで選んだファイルの親directoryを、同一Rust transaction内でactive化する。
#[tauri::command]
pub async fn app_pick_file_and_activate_project_root(
    app: AppHandle,
    state: State<'_, AppState>,
    title: Option<String>,
) -> CommandResult<Option<PickedProjectFile>> {
    let Some(selected_file) = crate::commands::dialog::pick_file(&app, title, None).await else {
        return Ok(None);
    };
    let parent = Path::new(&selected_file)
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| CommandError::validation("selected file has no parent directory"))?;
    let project_root = persist_and_activate(&app, &state, capture_identity(parent).await?).await?;
    Ok(Some(PickedProjectFile {
        project_root,
        file_path: selected_file,
    }))
}

/// active rootを明示的に解除する。これは権限の追加を行わないため、rendererからの呼び出しは
/// denial-of-service以外の権限昇格を生まない。
#[tauri::command]
pub async fn app_clear_active_project_root(state: State<'_, AppState>) -> CommandResult<()> {
    let _guard = LEDGER_WRITE_LOCK.lock().await;
    let mut ledger = load_ledger().await?;
    ledger.active = None;
    write_ledger(&ledger).await?;
    crate::state::set_project_root_authority(
        &state.project_root,
        &state.project_root_identity,
        None,
    );
    crate::commands::fs_watch::stop_active_watcher();
    Ok(())
}

/// native picker由来のworkspace rootだけをledgerへ追加する。
#[tauri::command]
pub async fn app_pick_workspace_root(
    app: AppHandle,
    title: Option<String>,
) -> CommandResult<Option<String>> {
    let Some(selected) = crate::commands::dialog::pick_folder(&app, title).await else {
        return Ok(None);
    };
    let identity = capture_identity(selected).await?;
    let _guard = LEDGER_WRITE_LOCK.lock().await;
    let mut ledger = load_ledger().await?;
    if ledger.active.as_ref() == Some(&identity) {
        return Err(CommandError::validation(
            "active project root cannot also be added as a workspace root",
        ));
    }
    if !ledger
        .workspace_roots
        .iter()
        .any(|known| known == &identity)
    {
        ledger.workspace_roots.push(identity.clone());
        write_ledger(&ledger).await?;
    }
    Ok(Some(identity.canonical_root))
}

/// すでにnative pickerで承認されたworkspaceだけをprimary rootへ昇格する。
/// rendererのraw pathはlookupにしか使わず、ledger内の同一identityがなければfail-closed。
#[tauri::command]
pub async fn app_activate_authorized_workspace_root(
    app: AppHandle,
    state: State<'_, AppState>,
    project_root: String,
) -> CommandResult<String> {
    let requested = capture_identity(project_root).await?;
    let _guard = LEDGER_WRITE_LOCK.lock().await;
    let previous = load_ledger().await?;
    let Some(identity) = previous
        .workspace_roots
        .iter()
        .find(|known| *known == &requested)
        .cloned()
    else {
        return Err(CommandError::authz(
            "workspace root was not approved by a native selection",
        ));
    };
    verify_identity(&identity).await?;
    let mut next = previous.clone();
    next.active = Some(identity.clone());
    // primaryへ昇格したgrantをworkspace集合に残すと、UIでprimaryを削除した後も
    // hidden workspace authorityとして残る。activeとの二重所属を作らない。
    next.workspace_roots.retain(|known| known != &identity);
    write_ledger(&next).await?;
    if let Err(error) = verify_identity(&identity).await {
        write_ledger(&previous).await.map_err(|rollback_error| {
            CommandError::internal(format!(
                "workspace activation failed ({error}); authority rollback also failed: {rollback_error}"
            ))
        })?;
        return Err(error);
    }
    activate_verified_root(&app, &state, &identity);
    Ok(identity.canonical_root)
}

/// workspace grantを解除する。認可を追加しない操作なので、raw pathは照合専用に使う。
#[tauri::command]
pub async fn app_revoke_workspace_root(project_root: String) -> CommandResult<()> {
    let _guard = LEDGER_WRITE_LOCK.lock().await;
    let mut ledger = load_ledger().await?;
    // revokeはauthorityを追加しないため、削除済みdirectoryでも表示上のcanonical keyだけで
    // stale grantを取り除ける。実在するpathではidentity一致を優先して表記揺れも吸収する。
    let requested = capture_identity(&project_root).await.ok();
    let requested_key = canonical_root_key(Path::new(project_root.trim()));
    let before = ledger.workspace_roots.len();
    ledger
        .workspace_roots
        .retain(|known| requested.as_ref() != Some(known) && known.canonical_root != requested_key);
    if ledger.workspace_roots.len() != before {
        write_ledger(&ledger).await?;
    }
    Ok(())
}

/// startup用。settings値は一切参照せず、native選択で記録されたgrantだけを復元する。
pub async fn restore_active_project_root(app: &AppHandle) {
    // picker / clear / workspace mutationと同じ直列化域でsnapshotを読む。これが無いと古い
    // ledger=Aを読んだrestoreが、新しいpicker=BのstateをAへ巻き戻せる。
    let _guard = LEDGER_WRITE_LOCK.lock().await;
    let ledger = match load_ledger().await {
        Ok(ledger) => ledger,
        Err(error) => {
            tracing::warn!("[project-authority] restore skipped: {error}");
            return;
        }
    };
    let Some(identity) = ledger.active else {
        return;
    };
    if let Err(error) = verify_identity(&identity).await {
        tracing::warn!("[project-authority] saved root rejected during restore: {error}");
        return;
    }
    let state = app.state::<AppState>();
    activate_verified_root(app, &state, &identity);
}

/// renderer初期化時の同期点。setup時の非同期restoreと競合しても、git/sessionsを発火する前に
/// native ledgerの復元完了を待てるようにする。
#[tauri::command]
pub async fn app_restore_authorized_project_root(app: AppHandle) -> String {
    restore_active_project_root(&app).await;
    crate::state::current_project_root(&app.state::<AppState>().project_root).unwrap_or_default()
}

/// files系のworkspace gate用。settings.jsonではなくnative ledgerのidentity一致だけを認める。
pub async fn is_authorized_workspace_root(requested_canonical: &Path) -> bool {
    let ledger = match load_ledger().await {
        Ok(ledger) => ledger,
        Err(error) => {
            tracing::warn!("[project-authority] workspace ledger unavailable: {error}");
            return false;
        }
    };
    let requested = match capture_identity(requested_canonical.to_path_buf()).await {
        Ok(identity) => identity,
        Err(_) => return false,
    };
    ledger
        .workspace_roots
        .iter()
        .any(|known| known == &requested)
}

/// strict active-root gate用。AppState の文字列だけではなく、private ledgerに保存された
/// identityが現在も同一directoryを指していることまで確認する。
#[allow(dead_code)]
pub async fn is_authorized_active_root(requested_canonical: &Path) -> bool {
    let ledger = match load_ledger().await {
        Ok(ledger) => ledger,
        Err(error) => {
            tracing::warn!("[project-authority] active ledger unavailable: {error}");
            return false;
        }
    };
    let Some(active) = ledger.active else {
        return false;
    };
    let requested = match capture_identity(requested_canonical.to_path_buf()).await {
        Ok(identity) => identity,
        Err(_) => return false,
    };
    requested == active
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn ledger_roundtrip_is_private_and_versioned() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("project-authority.json");
        let root = dir.path().join("project");
        tokio::fs::create_dir_all(&root).await.unwrap();
        let identity = capture_identity(root).await.unwrap();
        let ledger = ProjectAuthorityLedger {
            schema_version: PROJECT_AUTHORITY_SCHEMA_VERSION,
            active: Some(identity.clone()),
            workspace_roots: vec![identity],
        };
        write_ledger_to(&path, &ledger).await.unwrap();
        assert_eq!(load_ledger_from(&path).await.unwrap().active, ledger.active);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[tokio::test]
    async fn missing_ledger_does_not_migrate_renderer_settings_candidates() {
        let dir = tempdir().unwrap();
        let missing = dir.path().join("project-authority.json");
        let ledger = load_ledger_from(&missing).await.unwrap();
        assert!(ledger.active.is_none());
        assert!(ledger.workspace_roots.is_empty());
        assert_eq!(ledger.schema_version, PROJECT_AUTHORITY_SCHEMA_VERSION);
    }

    #[tokio::test]
    async fn replacement_at_same_path_invalidates_identity() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("project");
        let old = dir.path().join("old-project");
        tokio::fs::create_dir_all(&root).await.unwrap();
        let identity = capture_identity(&root).await.unwrap();
        tokio::fs::rename(&root, &old).await.unwrap();
        tokio::fs::create_dir_all(&root).await.unwrap();
        assert!(verify_identity(&identity).await.is_err());
    }
}

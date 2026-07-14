//! Issue #1193: project root を path の表記ではなく filesystem object として識別する。
//!
//! `project_authority.rs` (native picker + private ledger) から identity 取得・照合の
//! プリミティブだけを分離したモジュール。ledger の wire format (`ProjectRootIdentity`)
//! と、その snapshot 取得 (`capture_identity`) / 再照合 (`verify_identity`) を所有する。
//! renderer 入力を authority として扱わない原則はここで強制される。

use crate::commands::error::{CommandError, CommandResult};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub(crate) const PROJECT_AUTHORITY_SCHEMA_VERSION: u8 = 1;

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

pub(crate) fn canonical_root_key(path: &Path) -> String {
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
    // SAFETY: `BY_HANDLE_FILE_INFORMATION` は全フィールドが整数の POD なので zeroed 初期化は健全。
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: `file` は直前で成功 open した所有 handle で、この呼び出しの間 drop されず生存する。
    // `addr_of_mut!(info)` はスタック上の有効かつ整列済みの out-pointer で、API は成功時に
    // 構造体全体を書き込む。失敗時は直後の `ok == 0` 分岐で `info` を読まずに return する。
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
pub(crate) fn capture_identity_blocking(candidate: PathBuf) -> CommandResult<ProjectRootIdentity> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

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

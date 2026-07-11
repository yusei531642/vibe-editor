//! Capability-bound filesystem primitives for vibe-team skill installation.
//!
//! The only ambient operation is opening the already-authorized project root with
//! an OS no-follow directory handle. Every child lookup is relative to an open
//! directory handle and processes exactly one fixed component.

use cap_primitives::fs::{self as cap_fs, DirOptions, FollowSymlinks};
use std::fs::File;
use std::io::{self, Read, Write};
use std::path::Path;

const COMPONENTS: [&str; 3] = [".claude", "skills", "vibe-team"];
const FINAL_NAME: &str = "SKILL.md";

pub(super) enum ExistingAction {
    Skip,
    Replace,
}

pub(super) struct InstallOutcome {
    pub skipped: bool,
    pub overwritten: bool,
}

enum ExistingState {
    Missing,
    Text(String),
    Unreadable,
}

pub(super) fn install<F>(
    root: &Path,
    contents: &[u8],
    mut decide_existing: F,
) -> io::Result<InstallOutcome>
where
    F: FnMut(&str) -> ExistingAction,
{
    install_with_hook(root, contents, &mut decide_existing, |_| {})
}

fn install_with_hook<F, H>(
    root: &Path,
    contents: &[u8],
    decide_existing: &mut F,
    mut hook: H,
) -> io::Result<InstallOutcome>
where
    F: FnMut(&str) -> ExistingAction,
    H: FnMut(TestHookPoint),
{
    let dir = open_skill_dir(root)?;
    hook(TestHookPoint::AfterDirectoryOpen);
    let existing = read_existing(&dir)?;
    if let ExistingState::Text(text) = &existing {
        if matches!(decide_existing(text), ExistingAction::Skip) {
            return Ok(InstallOutcome {
                skipped: true,
                overwritten: false,
            });
        }
    }

    // Historical InstallSkillResult semantics only marked overwritten when
    // read_to_string succeeded. An unreadable/non-UTF8 regular file was
    // replaced but reported overwritten=false; preserve that public contract.
    let overwritten = matches!(existing, ExistingState::Text(_));
    let _ = final_entry_exists(&dir)?;
    hook(TestHookPoint::BeforeAtomicReplace);
    atomic_replace(&dir, contents)?;
    Ok(InstallOutcome {
        skipped: false,
        overwritten,
    })
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum TestHookPoint {
    AfterDirectoryOpen,
    BeforeAtomicReplace,
}

pub(super) fn open_skill_dir(root: &Path) -> io::Result<File> {
    let mut current = open_root_nofollow(root)?;
    for component in COMPONENTS {
        current = open_or_create_dir(&current, component)?;
    }
    Ok(current)
}

fn open_or_create_dir(parent: &File, component: &str) -> io::Result<File> {
    let path = Path::new(component);
    match cap_fs::stat(parent, path, FollowSymlinks::No) {
        Ok(metadata) => {
            if metadata.is_symlink() || !metadata.is_dir() {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "skill path component is not a safe directory",
                ));
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            match cap_fs::create_dir(parent, path, &DirOptions::new()) {
                Ok(()) => {}
                // Another installer may have created the component. Re-stat and
                // no-follow open below; an attacker-created link still fails closed.
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error),
            }
        }
        Err(error) => return Err(error),
    }

    cap_fs::open_dir_nofollow(parent, path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            error
        } else {
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                "skill path component could not be opened safely",
            )
        }
    })
}

fn read_existing(dir: &File) -> io::Result<ExistingState> {
    match cap_fs::stat(dir, Path::new(FINAL_NAME), FollowSymlinks::No) {
        Ok(metadata) => {
            if metadata.is_symlink() || !metadata.is_file() {
                return Err(unsafe_final_entry());
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(ExistingState::Missing),
        Err(error) => return Err(error),
    }

    let mut options = cap_fs::OpenOptions::new();
    options.read(true);
    let mut file = match cap_fs::open(dir, Path::new(FINAL_NAME), &options) {
        Ok(file) => file,
        Err(_) => return Ok(ExistingState::Unreadable),
    };
    let mut text = String::new();
    match file.read_to_string(&mut text) {
        Ok(_) => Ok(ExistingState::Text(text)),
        // Preserve the previous contract: every read_to_string error skipped
        // the content guards and proceeded to the atomic replacement path.
        Err(_) => Ok(ExistingState::Unreadable),
    }
}

fn final_entry_exists(dir: &File) -> io::Result<bool> {
    match cap_fs::stat(dir, Path::new(FINAL_NAME), FollowSymlinks::No) {
        Ok(metadata) if metadata.is_symlink() || !metadata.is_file() => Err(unsafe_final_entry()),
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn atomic_replace(dir: &File, contents: &[u8]) -> io::Result<()> {
    atomic_replace_with(dir, contents, |dir, temp_path| {
        cap_fs::rename(dir, temp_path, dir, Path::new(FINAL_NAME))
    })
}

fn atomic_replace_with<R>(dir: &File, contents: &[u8], rename: R) -> io::Result<()>
where
    R: FnOnce(&File, &Path) -> io::Result<()>,
{
    let temp_name = format!(
        ".{FINAL_NAME}.tmp.{}.{}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    );
    let temp_path = Path::new(&temp_name);
    let result = (|| {
        let mut options = cap_fs::OpenOptions::new();
        options.write(true).create_new(true);
        let mut temp = cap_fs::open(dir, temp_path, &options)?;
        temp.write_all(contents)?;
        temp.flush()?;
        temp.sync_all()?;
        drop(temp);

        // Reject a statically linked final entry. If it is raced in after this
        // check, rename replaces that directory entry without following it.
        let _ = final_entry_exists(dir)?;
        rename(dir, temp_path)
    })();

    if result.is_err() {
        let _ = cap_fs::remove_file(dir, temp_path);
    }
    result
}

#[cfg(test)]
pub(super) fn install_with_test_hook<F, H>(
    root: &Path,
    contents: &[u8],
    mut decide_existing: F,
    mut hook: H,
) -> io::Result<InstallOutcome>
where
    F: FnMut(&str) -> ExistingAction,
    H: FnMut(&str),
{
    install_with_hook(root, contents, &mut decide_existing, |point| {
        hook(match point {
            TestHookPoint::AfterDirectoryOpen => "after-directory-open",
            TestHookPoint::BeforeAtomicReplace => "before-atomic-replace",
        });
    })
}

#[cfg(test)]
pub(super) fn atomic_replace_with_forced_rename_failure(
    dir: &File,
    contents: &[u8],
) -> io::Result<()> {
    atomic_replace_with(dir, contents, |_, _| {
        Err(io::Error::other("injected rename failure"))
    })
}

fn unsafe_final_entry() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "SKILL.md is not a safe regular file",
    )
}

#[cfg(unix)]
fn open_root_nofollow(root: &Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;

    let mut options = std::fs::OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC);
    let file = options.open(root)?;
    if !file.metadata()?.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "authorized project root is not a directory",
        ));
    }
    Ok(file)
}

#[cfg(windows)]
fn open_root_nofollow(root: &Path) -> io::Result<File> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        // Deliberately omit FILE_SHARE_DELETE so the root cannot be renamed or
        // deleted while capability-relative lookups are in progress.
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(root)?;
    let metadata = file.metadata()?;
    if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "authorized project root is not a safe directory",
        ));
    }
    Ok(file)
}

#[cfg(not(any(unix, windows)))]
compile_error!("secure skill installation requires Unix or Windows no-follow directory handles");

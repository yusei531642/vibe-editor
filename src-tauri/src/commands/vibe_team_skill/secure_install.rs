//! Capability-bound filesystem primitives for vibe-team skill installation.
//!
//! The only ambient operation is opening the already-authorized project root with
//! an OS no-follow directory handle. Every child lookup is relative to an open
//! directory handle and processes exactly one fixed component.

use cap_primitives::fs::{self as cap_fs, DirOptions, FollowSymlinks};
use std::fs::File;
use std::io;
use std::path::Path;

const COMPONENTS: [&str; 3] = [".claude", "skills", "vibe-team"];

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

//! Issue #738: Windows 専用のコマンドパス解決ロジック。
//!
//! 旧 `session.rs` の `#[cfg(windows)]` 付きパス解決関数 (`windows_pathext` /
//! `windows_search_dirs` / `candidate_paths` / `resolve_windows_command_path` /
//! `is_windows_cmd_script` / `resolve_windows_spawn_command` 等) をそのまま切り出した。
//! モジュール全体が `#[cfg(windows)]` 配下に置かれるため、各 fn の `cfg` 属性は外している
//! (= 旧コードの「Windows でのみコンパイルされる」性質は保持)。
//!
//! `cmd` / `bat` スクリプトの `cmd.exe /C` ラップ、PATHEXT 解決、npm / Codex の
//! fallback ディレクトリ探索ロジックは一切変えていない。

use crate::util::log_redact::redact_home;
use anyhow::{anyhow, Result};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use super::spawn::{env_value, PreparedSpawnCommand};

pub(crate) fn resolve_windows_spawn_command(
    command: &str,
    args: Vec<String>,
    env: &std::collections::HashMap<String, String>,
) -> Result<PreparedSpawnCommand> {
    let pathext_raw = env_value(env, "PATHEXT");
    let pathext = windows_pathext(pathext_raw.as_deref());
    let search_dirs = windows_search_dirs(env);
    let resolved = resolve_windows_command_path(command, &search_dirs, &pathext)?;
    let mut spawn_args = args;
    let program = if is_windows_cmd_script(&resolved) {
        let mut wrapped = Vec::with_capacity(spawn_args.len() + 2);
        wrapped.push("/C".to_string());
        wrapped.push(resolved.to_string_lossy().into_owned());
        wrapped.append(&mut spawn_args);
        spawn_args = wrapped;
        env_value(env, "COMSPEC").unwrap_or_else(|| "cmd.exe".to_string())
    } else {
        resolved.to_string_lossy().into_owned()
    };

    Ok(PreparedSpawnCommand {
        requested_command: command.to_string(),
        resolved_command: resolved.to_string_lossy().into_owned(),
        program,
        args: spawn_args,
        path_entries: search_dirs.len(),
        pathext_present: pathext_raw.is_some(),
    })
}

pub(super) fn windows_pathext(raw: Option<&str>) -> Vec<String> {
    let values = raw
        .map(|s| {
            s.split(';')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| {
                    let ext = if s.starts_with('.') {
                        s.to_string()
                    } else {
                        format!(".{s}")
                    };
                    ext.to_ascii_lowercase()
                })
                .collect::<Vec<_>>()
        })
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| {
            [".com", ".exe", ".bat", ".cmd"]
                .iter()
                .map(|s| s.to_string())
                .collect()
        });

    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for ext in values {
        if seen.insert(ext.clone()) {
            out.push(ext);
        }
    }
    out
}

pub(super) fn windows_search_dirs(env: &std::collections::HashMap<String, String>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut seen = HashSet::new();
    let mut push_dir = |path: PathBuf| {
        let key = path.to_string_lossy().to_ascii_lowercase();
        if !key.trim().is_empty() && seen.insert(key) {
            dirs.push(path);
        }
    };

    if let Some(path) = env_value(env, "PATH") {
        for dir in std::env::split_paths(&path) {
            push_dir(dir);
        }
    }

    if let Some(appdata) = env_value(env, "APPDATA") {
        push_dir(PathBuf::from(appdata).join("npm"));
    }
    if let Some(userprofile) = env_value(env, "USERPROFILE") {
        push_dir(PathBuf::from(userprofile).join(".local").join("bin"));
    }
    if let Some(localappdata) = env_value(env, "LOCALAPPDATA") {
        let base = PathBuf::from(localappdata);
        push_dir(base.join("Microsoft").join("WindowsApps"));
        push_dir(base.join("OpenAI").join("Codex").join("bin"));
    }

    dirs
}

fn command_has_path_separator(command: &str) -> bool {
    command.contains('\\') || command.contains('/')
}

fn command_has_extension(command: &str) -> bool {
    Path::new(command).extension().is_some()
}

fn candidate_paths(base: &Path, pathext: &[String]) -> Vec<PathBuf> {
    if base.extension().is_some() {
        return vec![base.to_path_buf()];
    }
    let mut out = Vec::with_capacity(pathext.len() + 1);
    for ext in pathext {
        out.push(PathBuf::from(format!("{}{}", base.to_string_lossy(), ext)));
    }
    out.push(base.to_path_buf());
    out
}

pub(super) fn resolve_windows_command_path(
    command: &str,
    search_dirs: &[PathBuf],
    pathext: &[String],
) -> Result<PathBuf> {
    let direct_path = PathBuf::from(command);
    if direct_path.is_absolute() || command_has_path_separator(command) {
        for candidate in candidate_paths(&direct_path, pathext) {
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
        return Err(anyhow!(
            "command executable was not found: {}",
            redact_home(command)
        ));
    }

    if command_has_extension(command) {
        if let Ok(found) = which::which(command) {
            return Ok(found);
        }
    }

    for dir in search_dirs {
        for candidate in candidate_paths(&dir.join(command), pathext) {
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    Err(anyhow!(
        "command executable was not found: {} (searched {} PATH entries)",
        command,
        search_dirs.len()
    ))
}

fn is_windows_cmd_script(path: &Path) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
        .unwrap_or(false)
}

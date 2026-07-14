#![cfg(windows)]

use crate::pty::session::windows_resolve::{
    resolve_windows_command_path_with_wsl_probe, resolve_windows_spawn_command,
};
use std::collections::HashMap;
use std::path::PathBuf;

#[test]
fn bare_bash_prefers_git_bash_over_wsl_launcher() {
    let tmp = tempfile::tempdir().unwrap();
    let system32 = tmp.path().join("Windows").join("System32");
    let program_files = tmp.path().join("Program Files");
    let git_bin = program_files.join("Git").join("bin");
    std::fs::create_dir_all(&system32).unwrap();
    std::fs::create_dir_all(&git_bin).unwrap();
    std::fs::write(system32.join("bash.exe"), "").unwrap();
    let git_bash = git_bin.join("bash.exe");
    std::fs::write(&git_bash, "").unwrap();
    let env = HashMap::from([
        ("PATH".into(), system32.to_string_lossy().into_owned()),
        (
            "ProgramFiles".into(),
            program_files.to_string_lossy().into_owned(),
        ),
    ]);

    let prepared = resolve_windows_spawn_command("bash", vec![], &env).unwrap();
    assert_eq!(PathBuf::from(prepared.resolved_command), git_bash);
}

#[test]
fn bare_bash_rejects_unconfigured_wsl_but_accepts_configured_wsl() {
    let tmp = tempfile::tempdir().unwrap();
    let system32 = tmp.path().join("Windows").join("System32");
    std::fs::create_dir_all(&system32).unwrap();
    let wsl_bash = system32.join("bash.exe");
    std::fs::write(&wsl_bash, "").unwrap();
    let search_dirs = vec![system32];
    let pathext = vec![".exe".to_string()];

    let error =
        resolve_windows_command_path_with_wsl_probe("bash", &search_dirs, &pathext, |_| false)
            .unwrap_err();
    assert!(error.to_string().contains("Windows WSL launcher"));

    let resolved =
        resolve_windows_command_path_with_wsl_probe("bash", &search_dirs, &pathext, |_| true)
            .unwrap();
    assert_eq!(resolved, wsl_bash);
}

#[test]
fn explicit_wsl_bash_path_remains_supported() {
    let tmp = tempfile::tempdir().unwrap();
    let system32 = tmp.path().join("Windows").join("System32");
    std::fs::create_dir_all(&system32).unwrap();
    let wsl_bash = system32.join("bash.exe");
    std::fs::write(&wsl_bash, "").unwrap();

    let prepared =
        resolve_windows_spawn_command(&wsl_bash.to_string_lossy(), vec![], &HashMap::new())
            .unwrap();
    assert_eq!(PathBuf::from(prepared.resolved_command), wsl_bash);
}

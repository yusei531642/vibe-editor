use super::*;

fn assert_failed_without_path(result: &InstallSkillResult) {
    assert!(!result.ok, "unsafe install unexpectedly succeeded");
    assert!(result.path.is_none());
    assert!(!result.skipped);
    assert!(!result.overwritten);
    assert!(result.error.is_some());
}

#[cfg(unix)]
#[tokio::test]
async fn rejects_each_linked_parent_without_outside_write() {
    use std::os::unix::fs::symlink;

    for position in 0..3 {
        let project = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let canary = outside.path().join("canary");
        std::fs::write(&canary, b"unchanged").unwrap();

        let parents = [
            project.path().join(".claude"),
            project.path().join(".claude/skills"),
            project.path().join(".claude/skills/vibe-team"),
        ];
        if let Some(parent) = parents[position].parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        symlink(outside.path(), &parents[position]).unwrap();

        let result = install_skill_at(project.path(), false).await;
        assert_failed_without_path(&result);
        let error = result.error.as_deref().unwrap();
        assert!(!error.contains(&project.path().to_string_lossy().to_string()));
        assert!(!error.contains(&outside.path().to_string_lossy().to_string()));
        assert_eq!(std::fs::read(&canary).unwrap(), b"unchanged");
        assert!(
            !outside.path().join("SKILL.md").exists()
                && !outside.path().join("skills/vibe-team/SKILL.md").exists()
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn rejects_final_symlink_without_touching_outside_canary() {
    use std::os::unix::fs::symlink;

    let project = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(skill_dir(project.path())).unwrap();
    let canary = outside.path().join("outside-skill");
    std::fs::write(&canary, b"unchanged").unwrap();
    symlink(&canary, skill_path(project.path())).unwrap();

    let result = install_skill_at(project.path(), true).await;
    assert_failed_without_path(&result);
    let error = result.error.as_deref().unwrap();
    assert!(!error.contains(&project.path().to_string_lossy().to_string()));
    assert!(!error.contains(&outside.path().to_string_lossy().to_string()));
    assert_eq!(std::fs::read(&canary).unwrap(), b"unchanged");
}

#[tokio::test]
async fn new_install_then_identical_reinstall_preserves_contract() {
    let project = tempfile::tempdir().unwrap();
    let first = install_skill_at(project.path(), false).await;
    assert!(first.ok && !first.skipped && !first.overwritten);
    assert_eq!(
        first.path.as_deref(),
        Some(skill_path(project.path()).to_string_lossy().as_ref())
    );

    let second = install_skill_at(project.path(), false).await;
    assert!(second.ok && second.skipped && !second.overwritten);
    assert_eq!(
        std::fs::read_to_string(skill_path(project.path())).unwrap(),
        current_skill_text()
    );
}

#[tokio::test]
async fn rejects_non_regular_final_entry() {
    let project = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(skill_path(project.path())).unwrap();
    let result = install_skill_at(project.path(), true).await;
    assert_failed_without_path(&result);
}

#[cfg(unix)]
#[tokio::test]
async fn unreadable_existing_file_keeps_historical_replace_result_shape() {
    use std::os::unix::fs::PermissionsExt;

    let project = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(skill_dir(project.path())).unwrap();
    std::fs::write(skill_path(project.path()), b"old").unwrap();
    std::fs::set_permissions(
        skill_path(project.path()),
        std::fs::Permissions::from_mode(0o000),
    )
    .unwrap();

    let result = install_skill_at(project.path(), true).await;

    assert!(
        result.ok,
        "force self-heal must preserve the prior contract"
    );
    assert!(!result.overwritten, "historical read-error shape is false");
    assert_eq!(
        std::fs::read_to_string(skill_path(project.path())).unwrap(),
        current_skill_text()
    );
}

#[tokio::test]
async fn concurrent_installs_are_complete_and_leave_no_temp_files() {
    let project = tempfile::tempdir().unwrap();
    let root = std::sync::Arc::new(project.path().to_path_buf());
    let mut tasks = Vec::new();
    for _ in 0..16 {
        let root = root.clone();
        tasks.push(tokio::spawn(
            async move { install_skill_at(&root, true).await },
        ));
    }
    for task in tasks {
        assert!(task.await.unwrap().ok);
    }

    assert_eq!(
        std::fs::read_to_string(skill_path(&root)).unwrap(),
        current_skill_text()
    );
    let entries: Vec<_> = std::fs::read_dir(skill_dir(&root))
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(entries, [std::ffi::OsString::from("SKILL.md")]);
}

#[cfg(unix)]
#[test]
fn parent_swap_after_open_stays_bound_to_original_directory_handles() {
    use std::os::unix::fs::symlink;

    let project = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let moved = project.path().join(".claude-open-handle");
    let result = secure_install::install_with_test_hook(
        project.path(),
        b"safe body",
        |_| secure_install::ExistingAction::Replace,
        |point| {
            if point == "after-directory-open" {
                std::fs::rename(project.path().join(".claude"), &moved).unwrap();
                symlink(outside.path(), project.path().join(".claude")).unwrap();
            }
        },
    );

    assert!(result.is_ok());
    assert_eq!(
        std::fs::read(moved.join("skills/vibe-team/SKILL.md")).unwrap(),
        b"safe body"
    );
    assert!(!outside.path().join("skills/vibe-team/SKILL.md").exists());
}

#[cfg(unix)]
#[test]
fn final_swap_before_atomic_replace_fails_without_outside_write_or_temp_debris() {
    use std::os::unix::fs::symlink;

    let project = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(skill_dir(project.path())).unwrap();
    std::fs::write(skill_path(project.path()), b"old").unwrap();
    let canary = outside.path().join("canary");
    std::fs::write(&canary, b"unchanged").unwrap();

    let result = secure_install::install_with_test_hook(
        project.path(),
        b"new",
        |_| secure_install::ExistingAction::Replace,
        |point| {
            if point == "before-atomic-replace" {
                std::fs::remove_file(skill_path(project.path())).unwrap();
                symlink(&canary, skill_path(project.path())).unwrap();
            }
        },
    );

    assert!(result.is_err());
    assert_eq!(std::fs::read(&canary).unwrap(), b"unchanged");
    let names: Vec<_> = std::fs::read_dir(skill_dir(project.path()))
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(names, [std::ffi::OsString::from("SKILL.md")]);
}

#[test]
fn rename_failure_preserves_old_content_and_cleans_temp() {
    let project = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(skill_dir(project.path())).unwrap();
    std::fs::write(skill_path(project.path()), b"old").unwrap();
    let dir = secure_install::open_skill_dir(project.path()).unwrap();

    let result = secure_install::atomic_replace_with_forced_rename_failure(&dir, b"new");

    assert!(result.is_err());
    assert_eq!(std::fs::read(skill_path(project.path())).unwrap(), b"old");
    let names: Vec<_> = std::fs::read_dir(skill_dir(project.path()))
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(names, [std::ffi::OsString::from("SKILL.md")]);
}

#[cfg(windows)]
#[tokio::test]
async fn rejects_each_parent_directory_junction() {
    use std::process::Command;

    for position in 0..3 {
        let project = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let parents = [
            project.path().join(".claude"),
            project.path().join(".claude/skills"),
            project.path().join(".claude/skills/vibe-team"),
        ];
        if let Some(parent) = parents[position].parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let status = Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(&parents[position])
            .arg(outside.path())
            .status()
            .unwrap();
        assert!(status.success(), "junction fixture creation failed");

        let result = install_skill_at(project.path(), false).await;
        assert_failed_without_path(&result);
        assert!(!outside.path().join("SKILL.md").exists());
    }
}

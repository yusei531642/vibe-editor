use std::path::Path;

use tokio::fs;

use super::HandoffCheckpoint;

pub(super) async fn load_handoffs_from_dir(dir: &Path) -> Vec<HandoffCheckpoint> {
    let mut out = Vec::new();
    let Ok(mut rd) = fs::read_dir(dir).await else {
        return out;
    };
    while let Ok(Some(entry)) = rd.next_entry().await {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        if let Some(handoff) =
            crate::commands::safe_load::safe_load_or_quarantine::<HandoffCheckpoint>(&path, None)
                .await
                .into_option()
        {
            out.push(handoff);
        }
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::handoffs::HandoffContent;

    fn checkpoint(id: &str, created_at: &str) -> HandoffCheckpoint {
        HandoffCheckpoint {
            schema_version: crate::commands::schema_version::HANDOFF_SCHEMA_VERSION,
            id: id.to_string(),
            project_root: "/project".to_string(),
            team_id: Some("team".to_string()),
            kind: "session".to_string(),
            from_agent_id: None,
            from_role: None,
            from_agent: None,
            from_title: None,
            source_session_id: None,
            replacement_for_agent_id: None,
            to_agent_id: None,
            retire_after_ack: false,
            trigger: "test".to_string(),
            status: "created".to_string(),
            created_at: created_at.to_string(),
            updated_at: created_at.to_string(),
            json_path: format!("/{id}.json"),
            markdown_path: format!("/{id}.md"),
            content: HandoffContent {
                summary: id.to_string(),
                ..Default::default()
            },
        }
    }

    async fn write_checkpoint(dir: &Path, checkpoint: &HandoffCheckpoint) {
        let bytes = serde_json::to_vec(checkpoint).unwrap();
        fs::write(dir.join(format!("{}.json", checkpoint.id)), bytes)
            .await
            .unwrap();
    }

    async fn backup_paths(dir: &Path, file_name: &str) -> Vec<std::path::PathBuf> {
        let prefix = format!("{file_name}.bak.");
        let mut paths = Vec::new();
        let mut entries = fs::read_dir(dir).await.unwrap();
        while let Some(entry) = entries.next_entry().await.unwrap() {
            if entry.file_name().to_string_lossy().starts_with(&prefix) {
                paths.push(entry.path());
            }
        }
        paths.sort();
        paths
    }

    #[tokio::test]
    async fn list_keeps_valid_entry_and_quarantines_corrupt_json() {
        let dir = tempfile::tempdir().unwrap();
        let valid = checkpoint("valid", "2026-07-10T11:00:00Z");
        write_checkpoint(dir.path(), &valid).await;

        let corrupt = b"{ this is not valid json";
        let corrupt_path = dir.path().join("corrupt.json");
        fs::write(&corrupt_path, corrupt).await.unwrap();

        let listed = load_handoffs_from_dir(dir.path()).await;
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, valid.id);

        let backups = backup_paths(dir.path(), "corrupt.json").await;
        assert_eq!(backups.len(), 1);
        assert_eq!(fs::read(&backups[0]).await.unwrap(), corrupt);
    }

    #[tokio::test]
    async fn list_sorts_valid_entries_and_requarantines_multiple_corrupt_files() {
        let dir = tempfile::tempdir().unwrap();
        let older = checkpoint("older", "2026-07-10T10:00:00Z");
        let newer = checkpoint("newer", "2026-07-10T12:00:00Z");
        write_checkpoint(dir.path(), &older).await;
        write_checkpoint(dir.path(), &newer).await;

        let corrupt_files = [
            ("broken-a.json", b"{ broken a".as_slice()),
            ("broken-b.json", b"{ broken b".as_slice()),
        ];
        for (name, bytes) in corrupt_files {
            fs::write(dir.path().join(name), bytes).await.unwrap();
        }

        for expected_backup_count in 1..=2 {
            let listed = load_handoffs_from_dir(dir.path()).await;
            let ids = listed
                .iter()
                .map(|handoff| handoff.id.as_str())
                .collect::<Vec<_>>();
            assert_eq!(ids, ["newer", "older"]);

            for (name, bytes) in corrupt_files {
                let backups = backup_paths(dir.path(), name).await;
                assert_eq!(backups.len(), expected_backup_count);
                for backup in backups {
                    assert_eq!(fs::read(backup).await.unwrap(), bytes);
                }
            }
        }
    }

    #[tokio::test]
    async fn list_stays_within_the_requested_directory_and_tolerates_read_errors() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("handoffs");
        fs::create_dir(&dir).await.unwrap();

        let direct = checkpoint("direct", "2026-07-10T10:00:00Z");
        write_checkpoint(&dir, &direct).await;

        let nested = dir.join("nested");
        fs::create_dir(&nested).await.unwrap();
        write_checkpoint(&nested, &checkpoint("nested", "2026-07-10T11:00:00Z")).await;
        fs::create_dir(dir.join("unreadable.json")).await.unwrap();
        fs::write(dir.join("ignored.json.bak.20260710-120000"), b"not scanned")
            .await
            .unwrap();

        let listed = load_handoffs_from_dir(&dir).await;
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, direct.id);

        let not_a_directory = root.path().join("plain-file");
        fs::write(&not_a_directory, b"plain").await.unwrap();
        assert!(load_handoffs_from_dir(&not_a_directory).await.is_empty());
        assert!(load_handoffs_from_dir(&root.path().join("missing"))
            .await
            .is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn list_skips_corrupt_entry_without_panicking_when_backup_write_fails() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let valid = checkpoint("valid", "2026-07-10T10:00:00Z");
        write_checkpoint(dir.path(), &valid).await;
        fs::write(dir.path().join("corrupt.json"), b"{ broken")
            .await
            .unwrap();

        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o500)).unwrap();
        let listed = load_handoffs_from_dir(dir.path()).await;
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();

        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, valid.id);
        assert!(backup_paths(dir.path(), "corrupt.json").await.is_empty());
    }
}

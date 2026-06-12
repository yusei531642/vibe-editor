// commands/terminal/prompt_files.rs
//
// Terminal agent system prompts are often too large for Windows command-line
// limits when passed inline. Keep the prompt body in a short-lived file and
// pass only the path to the CLI.

use std::path::{Path, PathBuf};
use uuid::Uuid;

/// Issue #99: Codex の system prompt を一時ファイルに書き、`--config model_instructions_file=...`
/// を args 末尾に追加する。書き出し先は `~/.vibe-editor/codex-instructions/`。
pub async fn prepare_codex_instructions_file(instructions: &str) -> Option<PathBuf> {
    prepare_prompt_file("codex-instructions", "instr", instructions).await
}

/// Issue #858: Claude の `--append-system-prompt <long prompt>` は Windows の
/// command-line length limit に当たりやすい。`--append-system-prompt-file <path>` に逃がす。
pub async fn prepare_claude_append_system_prompt_file(prompt: &str) -> Option<PathBuf> {
    prepare_prompt_file("claude-system-prompts", "append", prompt).await
}

async fn prepare_prompt_file(dir_name: &str, prefix: &str, body: &str) -> Option<PathBuf> {
    let root = crate::util::config_paths::vibe_root();
    prepare_prompt_file_in_root(&root, dir_name, prefix, body).await
}

async fn prepare_prompt_file_in_root(
    root: &Path,
    dir_name: &str,
    prefix: &str,
    body: &str,
) -> Option<PathBuf> {
    if body.trim().is_empty() {
        return None;
    }
    let dir = root.join(dir_name);
    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        tracing::warn!("[terminal] prompt file dir create failed ({dir_name}): {e}");
        return None;
    }
    enforce_private_prompt_dir(root, "vibe-root").await;
    enforce_private_prompt_dir(&dir, dir_name).await;
    cleanup_old_prompt_files(&dir).await;
    let path = dir.join(format!("{prefix}-{}.md", Uuid::new_v4()));
    if let Err(e) =
        crate::commands::atomic_write::atomic_write_with_mode(&path, body.as_bytes(), Some(0o600))
            .await
    {
        tracing::warn!("[terminal] prompt file write failed ({dir_name}): {e}");
        return None;
    }
    Some(path)
}

/// Issue #891 (security): system prompt files contain role/project context.
/// On multi-user Unix hosts, both the prompt dir and its parent must be owner-only
/// so other users cannot traverse to short-lived prompt files. Windows ignores POSIX modes.
async fn enforce_private_prompt_dir(dir: &Path, label: &str) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) =
            tokio::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).await
        {
            tracing::warn!(
                "[terminal] failed to chmod 0o700 on prompt dir {label} ({}): {e}",
                dir.display()
            );
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (dir, label);
    }
}

/// Issue #99 / #858: 古い prompt files を TTL で掃除 (paste-images と同じ best-effort)。
pub async fn cleanup_old_prompt_files(dir: &Path) {
    const TTL_SECS: u64 = 24 * 60 * 60;
    let Ok(mut rd) = tokio::fs::read_dir(dir).await else {
        return;
    };
    let now = std::time::SystemTime::now();
    while let Ok(Some(entry)) = rd.next_entry().await {
        let Ok(meta) = entry.metadata().await else {
            continue;
        };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        let age = now.duration_since(modified).unwrap_or_default();
        if age.as_secs() > TTL_SECS {
            let _ = tokio::fs::remove_file(entry.path()).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn empty_prompt_body_returns_none() {
        let root = tempfile::tempdir().unwrap();

        let path =
            prepare_prompt_file_in_root(root.path(), "codex-instructions", "instr", "  ").await;

        assert!(path.is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn prompt_file_and_dirs_are_private_on_unix() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let path = prepare_prompt_file_in_root(
            root.path(),
            "codex-instructions",
            "instr",
            "secret prompt",
        )
        .await
        .expect("prompt file should be created");

        let root_mode = tokio::fs::metadata(root.path())
            .await
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        let dir_mode = tokio::fs::metadata(root.path().join("codex-instructions"))
            .await
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        let file_mode = tokio::fs::metadata(&path)
            .await
            .unwrap()
            .permissions()
            .mode()
            & 0o777;

        assert_eq!(root_mode, 0o700, "vibe root should be 0o700");
        assert_eq!(dir_mode, 0o700, "prompt dir should be 0o700");
        assert_eq!(file_mode, 0o600, "prompt file should be 0o600");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn existing_loose_prompt_dirs_are_tightened_on_unix() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("claude-system-prompts");
        tokio::fs::create_dir_all(&dir).await.unwrap();
        tokio::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o755))
            .await
            .unwrap();
        tokio::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755))
            .await
            .unwrap();

        let path = prepare_prompt_file_in_root(
            root.path(),
            "claude-system-prompts",
            "append",
            "secret prompt",
        )
        .await
        .expect("prompt file should be created");

        let root_mode = tokio::fs::metadata(root.path())
            .await
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        let dir_mode = tokio::fs::metadata(&dir)
            .await
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        let file_mode = tokio::fs::metadata(path)
            .await
            .unwrap()
            .permissions()
            .mode()
            & 0o777;

        assert_eq!(root_mode, 0o700, "existing loose root should be tightened");
        assert_eq!(
            dir_mode, 0o700,
            "existing loose prompt dir should be tightened"
        );
        assert_eq!(file_mode, 0o600, "prompt file should be 0o600");
    }
}

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
    if body.trim().is_empty() {
        return None;
    }
    let dir = crate::util::config_paths::vibe_root().join(dir_name);
    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        tracing::warn!("[terminal] prompt file dir create failed ({dir_name}): {e}");
        return None;
    }
    cleanup_old_prompt_files(&dir).await;
    let path = dir.join(format!("{prefix}-{}.md", Uuid::new_v4()));
    if let Err(e) = tokio::fs::write(&path, body).await {
        tracing::warn!("[terminal] prompt file write failed ({dir_name}): {e}");
        return None;
    }
    Some(path)
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

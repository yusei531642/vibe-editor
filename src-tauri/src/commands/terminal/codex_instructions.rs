// commands/terminal/codex_instructions.rs
//
// terminal.rs から move された codex instructions 用 helper (Phase 3 / Issue #373)。
// PTY race とは無関係 (inject_codex_prompt_to_pty 本体は terminal.rs に残る)。

use std::path::PathBuf;
use uuid::Uuid;

/// Issue #99: Codex の system prompt を一時ファイルに書き、`--config model_instructions_file=...`
/// を args 末尾に追加する。書き出し先は `~/.vibe-editor/codex-instructions/`。
/// ディレクトリは起動時に best-effort で TTL=7日 のクリーンアップを掛ける。
pub async fn prepare_codex_instructions_file(instructions: &str) -> Option<PathBuf> {
    if instructions.trim().is_empty() {
        return None;
    }
    let dir = dirs::home_dir()
        .unwrap_or_default()
        .join(".vibe-editor")
        .join("codex-instructions");
    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        tracing::warn!("[terminal] codex-instructions dir create failed: {e}");
        return None;
    }
    cleanup_old_codex_instructions(&dir).await;
    let path = dir.join(format!("instr-{}.md", Uuid::new_v4()));
    if let Err(e) = tokio::fs::write(&path, instructions).await {
        tracing::warn!("[terminal] codex-instructions write failed: {e}");
        return None;
    }
    Some(path)
}

/// Issue #99: 古い codex 指示ファイルを TTL で掃除 (paste-images と同じ best-effort)。
pub async fn cleanup_old_codex_instructions(dir: &std::path::Path) {
    // Issue #138: 旧 7 日 → 24h に短縮。情報残存リスクを下げる
    const TTL_SECS: u64 = 24 * 60 * 60;
    let Ok(mut rd) = tokio::fs::read_dir(dir).await else {
        return;
    };
    let now = std::time::SystemTime::now();
    while let Ok(Some(entry)) = rd.next_entry().await {
        let Ok(meta) = entry.metadata().await else { continue };
        let Ok(modified) = meta.modified() else { continue };
        let age = now.duration_since(modified).unwrap_or_default();
        if age.as_secs() > TTL_SECS {
            let _ = tokio::fs::remove_file(entry.path()).await;
        }
    }
}

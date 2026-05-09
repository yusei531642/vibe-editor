// Codex MCP 設定 (~/.codex/config.toml) の `[mcp_servers.vibe-team]` を更新

use anyhow::Result;
use std::path::{Path, PathBuf};
use tokio::fs;

const SECTION: &str = "mcp_servers.vibe-team";
const LEGACY_SECTION: &str = "mcp_servers.vive-team";

/// Issue #44: TOML basic string の正式な escape。
/// `"`, `\`, 制御文字 (U+0000..U+001F / U+007F) をバックスラッシュシーケンスに変換する。
/// これをやらないと、bridge_path に `"` が含まれた瞬間に config.toml が壊れる。
fn toml_escape_basic_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\u{0008}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{000C}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            c if (c as u32) < 0x20 || c as u32 == 0x7f => {
                out.push_str(&format!("\\u{:04X}", c as u32));
            }
            c => out.push(c),
        }
    }
    out
}

pub(crate) fn config_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".codex")
        .join("config.toml")
}

/// 旧 removeTomlSection と完全互換 — `[section]` および `[section.*]` を削除。
pub fn remove_toml_section(content: &str, section: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    let mut skip = false;
    for line in content.split('\n') {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            let name = trimmed[1..trimmed.len() - 1].trim();
            skip = name == section || name.starts_with(&format!("{section}."));
        }
        if !skip {
            out.push(line);
        }
    }
    while out.last().is_some_and(|s| s.trim().is_empty()) {
        out.pop();
    }
    out.join("\n")
}

/// Issue #597: テスト容易化のため path を引数に取る (production code は config_path() を渡す)。
pub(crate) async fn setup_at(path: &Path, bridge_path: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let mut content: String = fs::read_to_string(path).await.unwrap_or_default();
    content = remove_toml_section(&content, SECTION);
    content = remove_toml_section(&content, LEGACY_SECTION);
    // Issue #44: bridge_path を TOML basic string 用に正規 escape。
    // まず Windows の `\` → `/` に変えて (node 側に渡すときの可搬性優先)、その上で
    // 万が一 `"` 等を含むパスが来ても構文を壊さないように basic escape を通す。
    let normalized = bridge_path.replace('\\', "/");
    let escaped = toml_escape_basic_string(&normalized);
    let section = format!(
        "\n[{SECTION}]\ncommand = \"node\"\nargs = [\"{escaped}\"]\nenv_vars = [\"VIBE_TEAM_ID\", \"VIBE_TEAM_ROLE\", \"VIBE_AGENT_ID\", \"VIBE_TEAM_SOCKET\", \"VIBE_TEAM_TOKEN\"]\n",
    );
    // Issue #37: ~/.codex/config.toml も他アプリと共有なので atomic に上書き
    let data = (content + &section).into_bytes();
    crate::commands::atomic_write::atomic_write(path, &data).await?;
    Ok(())
}

pub(crate) async fn cleanup_at(path: &Path) -> Result<()> {
    let Ok(content) = fs::read_to_string(path).await else {
        return Ok(());
    };
    let stripped = remove_toml_section(&content, SECTION);
    let stripped = remove_toml_section(&stripped, LEGACY_SECTION);
    let cleaned = format!("{}\n", stripped.trim_end());
    crate::commands::atomic_write::atomic_write(path, cleaned.as_bytes()).await?;
    Ok(())
}

/// Issue #597: setup/cleanup の rollback 用に、現状のファイル内容を丸ごとスナップショット。
/// `Ok(None)` はファイル未存在 (= 元々何も無い)。restore_at() で None を渡すとファイル削除で原状回復する。
/// claude::snapshot_at() と対称 — どちらか片方だけ snapshot を持つ片肺 rollback を防ぐため。
pub(crate) async fn snapshot_at(path: &Path) -> Result<Option<Vec<u8>>> {
    match fs::read(path).await {
        Ok(b) => Ok(Some(b)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Issue #597: snapshot_at() で取った状態へ atomic に書き戻す。claude::restore_at() と対称。
pub(crate) async fn restore_at(path: &Path, snap: Option<Vec<u8>>) -> Result<()> {
    match snap {
        Some(bytes) => {
            crate::commands::atomic_write::atomic_write(path, &bytes).await?;
        }
        None => {
            // 元々ファイルが無かった場合は削除して原状回復。
            // 既に存在しなければ NotFound が返るが、無視して OK。
            let _ = fs::remove_file(path).await;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn snapshot_returns_none_when_file_absent() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("config.toml");
        let snap = snapshot_at(&path).await.unwrap();
        assert!(snap.is_none(), "absent file should yield None");
    }

    #[tokio::test]
    async fn snapshot_returns_bytes_for_existing_file() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("config.toml");
        fs::write(&path, b"[other]\nfoo = 1\n").await.unwrap();
        let snap = snapshot_at(&path).await.unwrap().expect("Some bytes");
        assert_eq!(snap, b"[other]\nfoo = 1\n");
    }

    #[tokio::test]
    async fn restore_writes_bytes_back() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("config.toml");
        fs::write(&path, b"current").await.unwrap();
        restore_at(&path, Some(b"original".to_vec())).await.unwrap();
        let got = fs::read(&path).await.unwrap();
        assert_eq!(got, b"original");
    }

    #[tokio::test]
    async fn restore_none_deletes_existing_file() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("config.toml");
        fs::write(&path, b"to-be-deleted").await.unwrap();
        restore_at(&path, None).await.unwrap();
        assert!(!path.exists(), "restore(None) should delete file");
    }

    #[tokio::test]
    async fn restore_none_is_noop_when_already_absent() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("config.toml");
        // 既に無い状態で restore(None) を呼んでも OK
        restore_at(&path, None).await.unwrap();
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn setup_then_restore_round_trips_to_original_bytes() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("config.toml");
        let original = b"[other]\nfoo = 1\n".to_vec();
        fs::write(&path, &original).await.unwrap();

        let snap = snapshot_at(&path).await.unwrap();
        // setup を走らせて vibe-team section を追加
        setup_at(&path, "/tmp/bridge.js").await.unwrap();
        let after_setup = fs::read(&path).await.unwrap();
        assert!(after_setup.windows(SECTION.len()).any(|w| w == SECTION.as_bytes()));

        // snapshot を使って巻き戻す
        restore_at(&path, snap).await.unwrap();
        let restored = fs::read(&path).await.unwrap();
        assert_eq!(restored, original, "restore should match original byte-for-byte");
    }

    #[tokio::test]
    async fn setup_then_restore_with_none_removes_file() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("config.toml");
        // 元々ファイルが無い状態で snapshot → None
        let snap = snapshot_at(&path).await.unwrap();
        assert!(snap.is_none());
        setup_at(&path, "/tmp/bridge.js").await.unwrap();
        assert!(path.exists());
        // restore(None) でファイル削除
        restore_at(&path, snap).await.unwrap();
        assert!(!path.exists(), "restore(None) should remove file created by setup");
    }
}

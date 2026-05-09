//! Issue #512: 長文 payload を `<project_root>/.vibe-team/tmp/<short_id>.md` に書き出して、
//! Hub から worker へは「summary + attached: <path>」の短文だけを inject する spool 機構。
//!
//! 旧実装は `SOFT_PAYLOAD_LIMIT` (32 KiB) を超える `team_send.message` / `team_assign_task.description`
//! を error で reject していた。Leader / HR / worker 全員に「長文は書き出してから path で渡す」
//! ルールを徹底させる必要があり、運用知識への依存が大きかった (Issue #107 の運用回避策)。
//! 本モジュールが「Hub が自動でファイル書き出し → 短文に置換」を行うことで、Leader が知らない
//! 状態でも安全に長文が流れる。
//!
//! ## API surface
//!
//! - [`spool_long_payload`]: `(project_root, content)` から `(spool_path, replacement_message)`
//!   を返す。caller (= `team_send` / `team_assign_task`) は replacement_message を inject に流す。
//! - [`cleanup_old_spools`]: TTL を超えた spool ファイルを削除。`TeamHub::start` から呼ぶ。
//!
//! ## 設計判断
//!
//! - **失敗時の fallback**: spool 書き出しが失敗 (write error / project_root 不在) しても caller
//!   側の team_send / assign_task を完全失敗させたくない。spool 失敗 = `Err(...)` を返し、caller は
//!   既存の「明示拒否」path に戻る (= 旧 `SOFT_PAYLOAD_LIMIT` 超過時の error 経路)。
//! - **summary 抽出**: 「先頭 N 行 + 改行」だけを残し、`Full content saved to: <path>` を末尾に付ける。
//!   80 行 (`SPOOL_SUMMARY_LINES`) は SKILL.md / WORKER_TEMPLATE で示すルールと整合。
//! - **path naming**: `<short_id>` は `nanoid` を使わず、UUID v4 の先頭 8 桁を使う (Hub が既に依存している
//!   `uuid` クレートで完結、依存追加なし)。`{prefix}-{short_id}.md` 形式で「どの tool 由来か」を可視化する。
//! - **TTL cleanup**: file の `modified` mtime を見て `SPOOL_TTL_HOURS` 超過なら削除。読み中の worker が
//!   いる可能性は低い (24 時間 = 通常 session 寿命より長い)。

use crate::team_hub::protocol::consts::{SPOOL_DIR, SPOOL_SUMMARY_LINES, SPOOL_TTL_HOURS};
use anyhow::{anyhow, Context, Result};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime};
use tokio::fs;
use uuid::Uuid;

/// Issue #636 (Security): spool 書き出し前に `project_root` を厳格検証する共通 helper。
///
/// 1. `trim` 後 empty 不可
/// 2. 絶対 path (relative 不可)
/// 3. `..` (Component::ParentDir) を含まない
/// 4. canonicalize 成功 (= 実在 + symlink resolution)
///
/// 旧実装は (1) のみで、`team_send({ data: <大>, project_root: "../../tmp/.../" })` のような
/// payload が hub state 経由で渡されたケースで spool が想定外ディレクトリに書ける余地があった。
/// canonicalize 失敗時の素 path フォールバック (line 81-85 旧) も廃止。
async fn validate_spool_root(project_root: &str) -> Result<PathBuf> {
    let project_root = project_root.trim();
    if project_root.is_empty() {
        return Err(anyhow!(
            "spool: project_root is empty; cannot write spool file"
        ));
    }
    let raw_root = Path::new(project_root);
    if !raw_root.is_absolute() {
        return Err(anyhow!(
            "spool: project_root must be absolute (got: {project_root})"
        ));
    }
    if raw_root
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err(anyhow!(
            "spool: project_root must not contain `..` (got: {project_root})"
        ));
    }
    fs::canonicalize(raw_root).await.map_err(|e| {
        anyhow!("spool: project_root canonicalize failed for {project_root}: {e}")
    })
}

/// spool 化結果。caller は `replacement_message` を inject に流し、`spool_path` をログ用に保持する。
#[derive(Debug, Clone)]
pub struct SpoolResult {
    /// 書き出した spool ファイルの **絶対パス** (worker が読みやすい形)。
    pub spool_path: PathBuf,
    /// inject に流す short message。`<summary>\n\n[Full content saved to: <abs_path>]` 形式。
    pub replacement_message: String,
}

/// 長文 payload を spool に書き出して、置換メッセージを返す。
///
/// 引数:
///   - `project_root`: spool 先 directory の親 (= `<project_root>/.vibe-team/tmp/`)。trim 必須。
///   - `content`: 元の長文本文 (UTF-8)。長さチェックは caller 側で済ませている前提。
///   - `prefix`: ファイル名 prefix (例: `"send"` / `"assign"`)。可視化用。
///
/// 戻り値:
///   - `Ok(SpoolResult)`: 書き出し成功
///   - `Err(...)`: project_root 不在 / write 失敗 / mkdir 失敗。caller は既存 reject path に fallback する想定。
pub async fn spool_long_payload(
    project_root: &str,
    content: &str,
    prefix: &str,
) -> Result<SpoolResult> {
    // Issue #636 (Security): project_root の厳格検証 (絶対 path / `..` 不可 / canonicalize 必須)
    // を入口で走らせ、`team_send({ project_root: "../../etc/..." })` 等の payload で spool が
    // 想定外ディレクトリに書かれるのを防ぐ。canonicalize 後の絶対 path を以後一貫して使う。
    let canonical_root = validate_spool_root(project_root).await?;
    let dir = canonical_root.join(SPOOL_DIR);
    fs::create_dir_all(&dir)
        .await
        .with_context(|| format!("spool: failed to create dir {}", dir.display()))?;
    // UUID v4 の先頭 8 hex を short_id にして衝突を低くしつつ短い名前にする。
    // 依存追加無しで一意性を確保 (uuid は team_hub の他の場所で既に使用)。
    let short_id = {
        let id = Uuid::new_v4().simple().to_string();
        id.chars().take(8).collect::<String>()
    };
    let safe_prefix = sanitize_prefix(prefix);
    let filename = format!("{safe_prefix}-{short_id}.md");
    let path = dir.join(filename);
    fs::write(&path, content)
        .await
        .with_context(|| format!("spool: failed to write {}", path.display()))?;
    // Issue #636: dir が canonical_root 配下なので、path も既に canonical 系の絶対 path。
    // 念のため canonicalize を試み、失敗時は構築済みの (canonical_root 配下の) path をそのまま使う
    // (raw な project_root に戻る fallback は Issue #636 で削除済み)。
    let abs_path = fs::canonicalize(&path).await.unwrap_or_else(|_| path.clone());
    let replacement_message = build_replacement_message(content, &abs_path);
    Ok(SpoolResult {
        spool_path: abs_path,
        replacement_message,
    })
}

/// `<project_root>/.vibe-team/tmp/` を走査し、`SPOOL_TTL_HOURS` を超過した entry を削除する。
/// 失敗は warn ログを残すだけで `Err` にはしない (cleanup は best-effort)。
pub async fn cleanup_old_spools(project_root: &str) {
    cleanup_old_spools_at(project_root, SystemTime::now()).await;
}

/// テスト時に `now` を任意に注入できる internal 形。`cleanup_old_spools` は `SystemTime::now()`
/// を渡す薄い wrapper。テストでは「now を 25 時間先送りする」だけで mtime 偽装不要に検証できる
/// (= filetime crate を dev-dep に増やさず、stdlib のみで時間判定の閾値を確認できる)。
async fn cleanup_old_spools_at(project_root: &str, now: SystemTime) {
    let project_root = project_root.trim();
    if project_root.is_empty() {
        return;
    }
    let dir = Path::new(project_root).join(SPOOL_DIR);
    let mut entries = match fs::read_dir(&dir).await {
        Ok(it) => it,
        Err(_) => return, // dir 不在は normal
    };
    let ttl = Duration::from_secs(SPOOL_TTL_HOURS * 3600);
    let mut removed = 0usize;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        let metadata = match entry.metadata().await {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !metadata.is_file() {
            continue;
        }
        let modified = match metadata.modified() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let age = now.duration_since(modified).unwrap_or(Duration::ZERO);
        if age <= ttl {
            continue;
        }
        if let Err(e) = fs::remove_file(&path).await {
            tracing::warn!(
                "[spool/cleanup] failed to remove expired spool {}: {e}",
                path.display()
            );
            continue;
        }
        removed += 1;
    }
    if removed > 0 {
        tracing::info!(
            "[spool/cleanup] removed {removed} expired spool file(s) under {}",
            dir.display()
        );
    }
}

/// inject に流す replacement message を組み立てる。
/// content が極端に短い場合 (= 想定外、SOFT_PAYLOAD_LIMIT 超過チェックを通過したはずなのに短文)
/// でも安全に動くよう、line 数 / 文字数 / prefix のいずれを取っても元 content を超えない設計にする。
fn build_replacement_message(content: &str, spool_path: &Path) -> String {
    let mut summary_lines: Vec<&str> = content.lines().take(SPOOL_SUMMARY_LINES).collect();
    let total_lines = content.lines().count();
    if total_lines > SPOOL_SUMMARY_LINES {
        summary_lines.push("…(truncated, see attached file)");
    }
    let summary = summary_lines.join("\n");
    let path_display = spool_path.display();
    format!(
        "{summary}\n\n[Full content saved to: {path_display}]\n(Use the Read tool to load the full body. Hub auto-spooled this message because it exceeded the 32 KiB inline limit.)"
    )
}

/// prefix に含まれる path 不安全文字を `_` に置換し、長さも短く保つ。
/// 例: `"send/all"` → `"send_all"`、空文字なら `"spool"`。
fn sanitize_prefix(prefix: &str) -> String {
    let cleaned: String = prefix
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .take(16)
        .collect();
    if cleaned.is_empty() {
        "spool".to_string()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn long_content(lines: usize) -> String {
        (0..lines)
            .map(|i| format!("line {i:04}: lorem ipsum"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[tokio::test]
    async fn spool_long_payload_writes_file_and_returns_replacement_with_path() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        let body = long_content(200); // 200 行 (SPOOL_SUMMARY_LINES=80 を超える)
        let result = spool_long_payload(&root, &body, "send")
            .await
            .expect("spool ok");
        // ファイルが存在し、本文が一致
        let written = tokio::fs::read_to_string(&result.spool_path).await.unwrap();
        assert_eq!(written, body, "spool に書かれた内容が元 content と一致すべき");
        // replacement message は元 path を含む
        let path_str = result.spool_path.display().to_string();
        assert!(
            result.replacement_message.contains(&path_str),
            "replacement message に spool path が含まれるべき"
        );
        // 80 行 truncate marker が出ている
        assert!(
            result.replacement_message.contains("(truncated"),
            "replacement に truncate marker が含まれるべき"
        );
    }

    #[tokio::test]
    async fn spool_long_payload_handles_short_content_without_truncate_marker() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        let body = long_content(10); // 80 行未満
        let result = spool_long_payload(&root, &body, "assign")
            .await
            .expect("spool ok");
        assert!(
            !result.replacement_message.contains("(truncated"),
            "短い content では truncate marker が出ないべき"
        );
    }

    #[tokio::test]
    async fn spool_long_payload_rejects_empty_project_root() {
        let err = spool_long_payload("", "body", "send").await.unwrap_err();
        assert!(err.to_string().contains("project_root is empty"));
    }

    /// Issue #636: relative path (絶対でない) は reject されること。
    #[tokio::test]
    async fn spool_long_payload_rejects_relative_project_root() {
        let err = spool_long_payload("relative/path", "body", "send")
            .await
            .unwrap_err();
        assert!(
            err.to_string().contains("must be absolute"),
            "expected `must be absolute` error, got: {err}"
        );
    }

    /// Issue #636: `..` を含む project_root は reject されること。
    #[tokio::test]
    async fn spool_long_payload_rejects_parent_dir_in_project_root() {
        // 絶対 path だが `..` を含む payload (canonicalize 前の段階で構文 reject)
        #[cfg(unix)]
        let bad = "/tmp/../etc";
        #[cfg(windows)]
        let bad = "C:\\Windows\\..\\Users";
        let err = spool_long_payload(bad, "body", "send").await.unwrap_err();
        assert!(
            err.to_string().contains("must not contain"),
            "expected `must not contain ..` error, got: {err}"
        );
    }

    /// Issue #636: 不存在 project_root は canonicalize 失敗で reject されること
    /// (旧実装では canonicalize 失敗時に raw path fallback で書こうとして別 dir 作成事故になりうる)。
    #[tokio::test]
    async fn spool_long_payload_rejects_nonexistent_project_root() {
        // tempdir の子 (= 実在しない一意 path) を渡す
        let tmp = TempDir::new().unwrap();
        let nonexistent = tmp.path().join("definitely-not-here-636");
        let err = spool_long_payload(
            nonexistent.to_string_lossy().as_ref(),
            "body",
            "send",
        )
        .await
        .unwrap_err();
        assert!(
            err.to_string().contains("canonicalize failed"),
            "expected `canonicalize failed` error, got: {err}"
        );
    }

    #[tokio::test]
    async fn cleanup_old_spools_removes_expired_files() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        let dir = tmp.path().join(SPOOL_DIR);
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let fresh = dir.join("fresh.md");
        let stale = dir.join("stale.md");
        // 両ファイルを書き出す。mtime はシステム時刻 (= 「今」)。
        tokio::fs::write(&fresh, b"fresh").await.unwrap();
        tokio::fs::write(&stale, b"stale").await.unwrap();
        // 「今」から 25 時間後の now を渡すと、両ファイルとも 25 時間古く見える。
        // ただし `fresh` は実際には ttl + 1 hour 経過しただけで、`stale` も同じ条件。
        // → 両方が削除される。テストは「`> ttl` なら削除」と「`<= ttl` なら残る」の両条件を見たいので、
        //   `cleanup_old_spools_at(root, now=stamp+1h)` で 1 時間だけ進めれば両方残るはず。
        let stamp = SystemTime::now();
        // 両方とも 1 時間後でも (1h <= 24h ttl) → 残る
        cleanup_old_spools_at(&root, stamp + Duration::from_secs(3600)).await;
        assert!(fresh.exists(), "1 時間経過程度では fresh は残るべき");
        assert!(stale.exists(), "1 時間経過程度では stale も残るべき");
        // 25 時間後の now にすると両方 stale 扱いになって削除される (= TTL 動作の検証)
        cleanup_old_spools_at(&root, stamp + Duration::from_secs(25 * 3600)).await;
        assert!(!fresh.exists(), "25 時間経過なら fresh も削除されるべき");
        assert!(!stale.exists(), "25 時間経過なら stale も削除されるべき");
    }

    #[test]
    fn sanitize_prefix_removes_unsafe_chars_and_truncates() {
        assert_eq!(sanitize_prefix("send/all"), "send_all");
        assert_eq!(sanitize_prefix("a".repeat(50).as_str()), "a".repeat(16));
        assert_eq!(sanitize_prefix(""), "spool");
        assert_eq!(sanitize_prefix("..*?<>"), "______");
    }
}

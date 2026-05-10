//! Issue #644: settings.json / role-profiles.json の `.bak` 退避を「単一上書き」から
//! 「タイムスタンプ + 世代回転」に変更するための共通 helper。
//!
//! # 背景
//!
//! 旧実装 (`settings_load` / `role_profiles_load` の parse 失敗フォールバック) は
//! `path.with_extension("json.bak")` で **常に同名の `.bak` を上書き** していた。
//! このため健全な v1 → 破損保存 v2 が走ると `.bak = v1` だが、次の破損保存 v3 で
//! `.bak = v2 (破損)` に書き換わり、原本 v1 が失われる。連続破損 (process kill /
//! disk error / 不正な migration) が走ると **復旧の最後の砦が消える**。
//!
//! # 仕様
//!
//! - バックアップ名は `<target>.bak.YYYYMMDD-HHMMSS` (UTC)。
//!   例: `settings.json.bak.20260509-120000`
//!   - `T` を含めない / `:` を含めない / 全部 ASCII で Windows でも安全。
//!   - 桁固定で lexicographic = chronological になる (sort してそのまま世代順)。
//! - 既存の同 prefix `<target>.bak.*` を列挙し、新しい順に `MAX_GENERATIONS` 世代
//!   (= 5) だけ残して古いものを削除する。
//! - 「同秒に 2 回 backup」した場合は filename 衝突を避けるため、必要なら
//!   `-1`, `-2` ... の連番 suffix を末尾に付ける (実運用上ほぼ起こらないが、
//!   テスト中の連続呼び出しで衝突しないことを担保する)。
//! - `.bak` の中身は `atomic_write_with_mode` で書く (mode は caller 指定)。
//!
//! # 既存仕様との互換
//!
//! - 旧 `<target>.bak` (タイムスタンプ無し) はそのまま残置する。
//!   - 削除すると ユーザーが手動で待避した `.bak` も巻き込んで消えるため危険。
//!   - rotation 対象は `<target>.bak.*` (timestamp 付き) のみ。
//!   - 互換のため、旧 `<target>.bak` 単独ファイルを生成することは廃止し、
//!     新仕様では常に `<target>.bak.<ts>` で書くようにする。
//!
//! # MAX_GENERATIONS = 5 の根拠
//!
//! - Issue #644 の Done criteria が「5 世代まで」を明示。
//! - 大半のユーザーは 1 世代で十分復旧できるが、連鎖破損 (migration バグ等) を
//!   考慮すると 5 ステップ前まで遡れると安全。
//! - 5 ファイル × 数 KB = 数十 KB 程度なのでディスク影響はゼロに近い。

use anyhow::Result;
use chrono::{DateTime, Utc};
use std::path::{Path, PathBuf};
use tokio::fs;

use crate::commands::atomic_write::atomic_write_with_mode;

/// Issue #644: バックアップ保持世代数。古いものから順に削除される。
pub const MAX_GENERATIONS: usize = 5;

/// `<target>.bak.YYYYMMDD-HHMMSS` を生成する。
///
/// `seq` が 0 のときは `<target>.bak.<ts>`、1 以上のときは `<target>.bak.<ts>-<seq>` を返す。
/// 同秒 collision を避けるためのフォールバック。
fn make_bak_path(target: &Path, now: DateTime<Utc>, seq: u32) -> PathBuf {
    let ts = now.format("%Y%m%d-%H%M%S").to_string();
    let file_name = target
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "vibe.bak".to_string());
    let bak_name = if seq == 0 {
        format!("{file_name}.bak.{ts}")
    } else {
        format!("{file_name}.bak.{ts}-{seq}")
    };
    match target.parent() {
        Some(p) => p.join(bak_name),
        None => PathBuf::from(bak_name),
    }
}

/// `<target>.bak.<...>` 形式 (タイムスタンプ付き) のバックアップファイルを列挙する。
///
/// 旧仕様の `<target>.bak` (タイムスタンプ無し) は **対象外** として残置する。
/// 戻り値は filename の昇順 (= タイムスタンプ昇順 = 古い順) で sort 済み。
async fn list_existing_backups(target: &Path) -> Vec<PathBuf> {
    let parent = match target.parent() {
        Some(p) => p,
        None => return Vec::new(),
    };
    let file_name = match target.file_name().and_then(|s| s.to_str()) {
        Some(s) => s.to_string(),
        None => return Vec::new(),
    };
    let prefix = format!("{file_name}.bak.");

    let Ok(mut rd) = fs::read_dir(parent).await else {
        return Vec::new();
    };
    let mut found: Vec<PathBuf> = Vec::new();
    while let Ok(Some(entry)) = rd.next_entry().await {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        // タイムスタンプ付き backup のみ対象 (旧 `.bak` 単独は無視)。
        if name.len() > prefix.len() && name.starts_with(&prefix) {
            found.push(path);
        }
    }
    // ファイル名は YYYYMMDD-HHMMSS 桁固定なので lexicographic sort = chronological sort。
    found.sort();
    found
}

/// 保持世代数を超える古いバックアップを削除する。
///
/// `existing` は古い順に sort された path 配列。`max_keep` 世代分を新しい側から残し、
/// それより古いものを `fs::remove_file` で best-effort に削除する。削除失敗は
/// tracing で警告するのみで、呼び出し側にエラーは伝播しない (本処理は backup 取得が
/// 主目的で、cleanup 失敗で全体を失敗させると逆に堅牢性が下がる)。
async fn prune_old_backups(existing: &[PathBuf], max_keep: usize) {
    if existing.len() <= max_keep {
        return;
    }
    let to_remove = existing.len() - max_keep;
    for p in existing.iter().take(to_remove) {
        if let Err(e) = fs::remove_file(p).await {
            tracing::warn!(
                "[backup] failed to prune old backup {}: {e}",
                p.display()
            );
        }
    }
}

/// `target` に対するタイムスタンプ付きバックアップを 1 つ作成し、世代上限を超える古いバックアップを削除する。
///
/// - `target`: バックアップ対象の本体 path (実在しなくても OK — `bytes` を直接書く)。
/// - `bytes`: 退避する内容 (settings parse 失敗時は元の生バイト列を渡す想定)。
/// - `mode`: Unix permission (None なら OS デフォルト)。Windows では no-op。
///
/// 戻り値は実際に書かれた `.bak` path。`atomic_write_with_mode` の I/O エラーはそのまま
/// 伝播する (caller は best-effort 扱いで `let _ = ...` で握りつぶしてよい)。
pub async fn write_timestamped_backup(
    target: &Path,
    bytes: &[u8],
    mode: Option<u32>,
) -> Result<PathBuf> {
    let now = Utc::now();
    // 同秒衝突を避けるための seq 探索。実運用ではほぼ 0 で確定するが、テストや高速連続
    // 呼び出しで `create_new` が衝突するのを避ける。
    let mut seq: u32 = 0;
    let bak_path = loop {
        let candidate = make_bak_path(target, now, seq);
        if !fs::try_exists(&candidate).await.unwrap_or(false) {
            break candidate;
        }
        seq += 1;
        if seq > 1000 {
            // pathological case: caller 側で何かおかしい。安全に諦める。
            anyhow::bail!(
                "backup path collision exhausted for {}",
                target.display()
            );
        }
    };

    atomic_write_with_mode(&bak_path, bytes, mode).await?;

    // 自身を含む既存リストを取り直して prune (新仕様の `.bak.<ts>` のみが対象)。
    let existing = list_existing_backups(target).await;
    prune_old_backups(&existing, MAX_GENERATIONS).await;

    Ok(bak_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// バックアップ名が `<file>.bak.YYYYMMDD-HHMMSS` 形式で生成されること。
    #[test]
    fn bak_path_uses_compact_timestamp_format() {
        let target = PathBuf::from("/tmp/vibe/settings.json");
        let now: DateTime<Utc> = "2026-05-09T12:34:56Z".parse().unwrap();
        let p = make_bak_path(&target, now, 0);
        assert_eq!(
            p.file_name().unwrap().to_string_lossy(),
            "settings.json.bak.20260509-123456"
        );
    }

    /// 同秒衝突時は `-1`, `-2` の連番 suffix が付くこと。
    #[test]
    fn bak_path_appends_seq_suffix_on_collision() {
        let target = PathBuf::from("/tmp/vibe/settings.json");
        let now: DateTime<Utc> = "2026-05-09T12:34:56Z".parse().unwrap();
        let p1 = make_bak_path(&target, now, 1);
        let p2 = make_bak_path(&target, now, 2);
        assert_eq!(
            p1.file_name().unwrap().to_string_lossy(),
            "settings.json.bak.20260509-123456-1"
        );
        assert_eq!(
            p2.file_name().unwrap().to_string_lossy(),
            "settings.json.bak.20260509-123456-2"
        );
    }

    /// `write_timestamped_backup` が timestamp 付きの `.bak` を作成し、内容が正しいこと。
    #[tokio::test]
    async fn writes_timestamped_backup_with_payload() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("settings.json");
        // target 自体は実在しなくてもよい (parse fail backup は元 bytes を直接渡す)
        let bak = write_timestamped_backup(&target, b"{\"v\":1}", None)
            .await
            .unwrap();
        let got = fs::read(&bak).await.unwrap();
        assert_eq!(&got, b"{\"v\":1}");
        let name = bak.file_name().unwrap().to_string_lossy().into_owned();
        assert!(
            name.starts_with("settings.json.bak."),
            "unexpected backup name: {name}"
        );
        assert!(name.len() >= "settings.json.bak.20260509-120000".len());
    }

    /// 旧仕様の `<target>.bak` (タイムスタンプ無し) は rotation 対象に含めない。
    #[tokio::test]
    async fn legacy_dotbak_is_not_rotated() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("settings.json");
        let legacy = dir.path().join("settings.json.bak");
        fs::write(&legacy, b"legacy").await.unwrap();

        // 6 世代超 backup を作る
        for i in 0..7 {
            write_timestamped_backup(&target, format!("v{i}").as_bytes(), None)
                .await
                .unwrap();
        }
        // 旧 `.bak` は残っている
        assert!(legacy.exists(), "legacy .bak should not be pruned");
    }

    /// MAX_GENERATIONS を超えた場合、最古から削除されて 5 世代に収まる。
    #[tokio::test]
    async fn prunes_old_backups_to_max_generations() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("settings.json");

        // 7 世代分作る (連続書き込みで同秒衝突は seq suffix で回避される)
        for i in 0..7 {
            write_timestamped_backup(&target, format!("v{i}").as_bytes(), None)
                .await
                .unwrap();
        }
        let remaining = list_existing_backups(&target).await;
        assert_eq!(
            remaining.len(),
            MAX_GENERATIONS,
            "expected exactly {} generations, got {}",
            MAX_GENERATIONS,
            remaining.len()
        );
    }

    /// rotation で残るのは「新しい側」N 世代であること。
    /// 古い (lexicographically 小さい) ファイルが消えていることを直接確認する。
    #[tokio::test]
    async fn rotation_keeps_newest_generations() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("settings.json");

        // 過去の 7 世代分を別々の timestamp で手動投入
        let oldest = "settings.json.bak.20200101-000000";
        let oldish = "settings.json.bak.20210101-000000";
        for stem in [
            oldest,
            oldish,
            "settings.json.bak.20220101-000000",
            "settings.json.bak.20230101-000000",
            "settings.json.bak.20240101-000000",
            "settings.json.bak.20250101-000000",
            "settings.json.bak.20260101-000000",
        ] {
            fs::write(dir.path().join(stem), stem.as_bytes())
                .await
                .unwrap();
        }
        // ここで新しい backup を 1 つ追加して prune を走らせる。
        write_timestamped_backup(&target, b"now", None).await.unwrap();

        let remaining = list_existing_backups(&target).await;
        assert_eq!(remaining.len(), MAX_GENERATIONS);
        assert!(
            !dir.path().join(oldest).exists(),
            "oldest backup should be pruned"
        );
        assert!(
            !dir.path().join(oldish).exists(),
            "second-oldest backup should be pruned"
        );
    }

    /// list_existing_backups は新しいファイル名を最後にして昇順 sort で返す。
    #[tokio::test]
    async fn list_returns_chronological_order() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("settings.json");
        fs::write(
            dir.path().join("settings.json.bak.20260101-000000"),
            b"a",
        )
        .await
        .unwrap();
        fs::write(
            dir.path().join("settings.json.bak.20260201-000000"),
            b"b",
        )
        .await
        .unwrap();
        let list = list_existing_backups(&target).await;
        assert_eq!(list.len(), 2);
        assert!(list[0]
            .file_name()
            .unwrap()
            .to_string_lossy()
            .ends_with("20260101-000000"));
        assert!(list[1]
            .file_name()
            .unwrap()
            .to_string_lossy()
            .ends_with("20260201-000000"));
    }
}

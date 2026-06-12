//! Issue #936: 永続化ファイルの「安全な読み込み」共通基盤。
//!
//! # 背景
//!
//! 書き込み側は [`crate::commands::atomic_write`] が共通プリミティブとして存在するが、
//! 読み込み側には共通基盤が無く、各ストアが `serde_json::from_slice(...).ok()?` 等で
//! parse 失敗を握り潰していた。その結果「破損 JSON → 黙ってデフォルト読込 → 次回 save で
//! 正常データを backup 無しに上書き消失」という **同型のデータ消失バグ** が各ストアで再発し、
//! 個別に起票・修正されてきた (#902 / #903 / #905 / #901 / #830 / #853 / #836)。
//!
//! 本モジュールは「**default に倒す前に必ず原本を退避する**」という不変条件を 1 か所に集約する。
//!
//! # 退避戦略
//!
//! 退避は [`crate::util::backup::write_timestamped_backup`] (`<file>.bak.<ts>` への
//! コピー + 5 世代回転) を用いる。これは role-profiles.json / settings.json /
//! terminal-tabs.json / team-history.json が既に採用している支配的な規約であり、
//! - 原本 path を **一切触らない** (コピーのみ) ため、退避中に並行 `atomic_write` が valid な
//!   file を置いても巻き込まない。team_state の `.corrupt` rename 退避が抱えていた TOCTOU
//!   eviction (#853) が **原理的に発生しない**。
//! - 連続破損でも世代回転で最後の砦が残る (#644)。
//!
//! という二点で安全側に倒れる。

use serde::de::DeserializeOwned;
use std::path::Path;

/// 永続化ファイル読み込みの結果。
#[derive(Debug)]
pub enum LoadOutcome<T> {
    /// 正常に parse できた。
    Loaded(T),
    /// ファイルが存在しない (初回起動 / 未保存)。呼び出し側は default を使ってよい。
    Absent,
    /// parse 失敗。原本は best-effort で退避済みなので、呼び出し側は default に倒してよい
    /// (次回 save で正常データを失わない)。
    Corrupted,
}

impl<T> LoadOutcome<T> {
    /// [`LoadOutcome::Loaded`] のときだけ `Some`。`Absent` / `Corrupted` は `None`。
    /// 「破損も不在も None でよい」既存ストア (例: `team_presets_load`) の移行用ショートカット。
    pub fn into_option(self) -> Option<T> {
        match self {
            LoadOutcome::Loaded(v) => Some(v),
            LoadOutcome::Absent | LoadOutcome::Corrupted => None,
        }
    }
}

/// `path` を読み `T` へ deserialize する。**parse 失敗時は default を返す前に原本を退避** し、
/// [`LoadOutcome::Corrupted`] を返す。ファイル不在は [`LoadOutcome::Absent`]。
///
/// - `backup_mode`: 退避ファイルの Unix permission。injection-prone な instructions を含む
///   機密ファイル (role-profiles / preset 等) は `Some(0o600)`、それ以外は `None`。
///   Windows では no-op。
///
/// IO エラー (NotFound 以外) も `Absent` に倒すが、痕跡として warn ログを残す。
pub async fn safe_load_or_quarantine<T: DeserializeOwned>(
    path: &Path,
    backup_mode: Option<u32>,
) -> LoadOutcome<T> {
    let bytes = match tokio::fs::read(path).await {
        Ok(b) => b,
        Err(e) => {
            // NotFound は通常状態 (未保存 / 初回起動) なので silent。それ以外は痕跡を残す。
            if e.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!("[safe_load] read failed for {}: {e}", path.display());
            }
            return LoadOutcome::Absent;
        }
    };
    safe_parse_or_quarantine(path, &bytes, backup_mode).await
}

/// Issue #947: 既に読み込んだ bytes を `T` へ parse する variant。
/// 呼び出し側が同じ bytes を fingerprint 計算 (#642 の外部変更検出) 等にも使うストア
/// (team-history / team-state) 向け。`safe_load_or_quarantine` を使うと read が二重になり、
/// fingerprint と parse が別スナップショットを見る race が生まれるため、こちらを使う。
/// 退避の不変条件 (default に倒す前に `.bak.<ts>` へコピー退避) は同一。
pub async fn safe_parse_or_quarantine<T: DeserializeOwned>(
    path: &Path,
    bytes: &[u8],
    backup_mode: Option<u32>,
) -> LoadOutcome<T> {
    match serde_json::from_slice::<T>(bytes) {
        Ok(v) => LoadOutcome::Loaded(v),
        Err(e) => {
            tracing::error!(
                "[safe_load] parse failed for {} ({e}); backing up corrupt original before \
                 falling back to default",
                path.display()
            );
            // #936 の core invariant: default に倒す前に必ず退避する。コピー退避なので
            // 原本 path を触らず、並行 save の valid file を巻き込まない (#853 の TOCTOU 回避)。
            match crate::util::backup::write_timestamped_backup(path, bytes, backup_mode).await {
                Ok(bak) => {
                    tracing::info!("[safe_load] wrote corrupt backup: {}", bak.display())
                }
                Err(berr) => tracing::warn!(
                    "[safe_load] corrupt backup failed for {}: {berr}",
                    path.display()
                ),
            }
            LoadOutcome::Corrupted
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use tokio::fs;

    #[derive(Debug, Deserialize, PartialEq)]
    struct Sample {
        a: u32,
        b: String,
    }

    #[tokio::test]
    async fn loads_valid_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sample.json");
        fs::write(&path, br#"{"a":7,"b":"hi"}"#).await.unwrap();

        let outcome = safe_load_or_quarantine::<Sample>(&path, None).await;
        match outcome {
            LoadOutcome::Loaded(v) => {
                assert_eq!(v, Sample { a: 7, b: "hi".to_string() })
            }
            other => panic!("expected Loaded, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn returns_absent_when_file_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("does-not-exist.json");

        let outcome = safe_load_or_quarantine::<Sample>(&path, None).await;
        assert!(matches!(outcome, LoadOutcome::Absent));
        assert!(outcome.into_option().is_none());
    }

    #[tokio::test]
    async fn quarantines_corrupt_file_before_returning_corrupted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("corrupt.json");
        let corrupt = b"{ this is not valid json";
        fs::write(&path, corrupt).await.unwrap();

        let outcome = safe_load_or_quarantine::<Sample>(&path, None).await;
        assert!(matches!(outcome, LoadOutcome::Corrupted));

        // 原本 path はコピー退避なので残置される (次回 save で上書きされる前提)。
        assert!(path.exists(), "original is left in place for copy-style backup");

        // `<file>.bak.<ts>` が作られ、破損原本の bytes を保持していること。
        let mut rd = fs::read_dir(dir.path()).await.unwrap();
        let mut found_backup: Option<std::path::PathBuf> = None;
        while let Ok(Some(entry)) = rd.next_entry().await {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("corrupt.json.bak.") {
                found_backup = Some(entry.path());
            }
        }
        let bak = found_backup.expect("a timestamped backup of the corrupt file must exist");
        let bak_bytes = fs::read(&bak).await.unwrap();
        assert_eq!(&bak_bytes, corrupt, "backup must preserve the corrupt original bytes");
    }

    #[tokio::test]
    async fn into_option_maps_loaded_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sample.json");
        fs::write(&path, br#"{"a":1,"b":"x"}"#).await.unwrap();
        let got = safe_load_or_quarantine::<Sample>(&path, None)
            .await
            .into_option();
        assert_eq!(got, Some(Sample { a: 1, b: "x".to_string() }));
    }
}

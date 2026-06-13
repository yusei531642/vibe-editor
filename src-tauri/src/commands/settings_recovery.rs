// settings_recovery — settings.json の parse 失敗時の復旧経路 (Issue #996)。
//
// 背景:
//   - settings_load は `~/.vibe-editor/settings.v11.bak` (pre-v12 スナップショット) を
//     書き出すが、v12 への migration / 保存が settings.json を壊した場合に、その健全な
//     スナップショットを読み戻さず default を返していた。計画 v2 の
//     「migration 失敗時は旧 settings を保持して v11 として読み続ける」を満たすため、
//     parse 失敗時の処理 (原本退避 + v11 復旧 + default) を本モジュールへ集約する。
//   - settings.rs は既に god-file (file-size baseline 免除) なので、復旧ロジックは
//     ここに分離して settings.rs を肥大化させない。

use super::settings::Settings;
use crate::util::backup::write_timestamped_backup;
use std::path::Path;
use tokio::fs;

/// settings.json の deserialize 失敗時の復旧。
///
/// 1. 破損した原本をタイムスタンプ付き backup へ退避 (Issue #644: 世代回転で過去 5 ステップ
///    分の原本に戻れる)。
/// 2. 直前の健全な v11 スナップショット (`settings.v11.bak`) があれば読み戻す (Issue #996)。
/// 3. どちらも不可なら `Settings::default()` を返す (Issue #170/#493: 旧実装の「silent Null +
///    次 save で全消失」を防ぐ)。
pub(crate) async fn recover_after_parse_failure(
    path: &Path,
    bytes: &[u8],
    err: serde_json::Error,
) -> Settings {
    tracing::error!(
        "[settings] parse failed ({}), backing up to {}.bak.<ts>",
        err,
        path.display()
    );
    // best-effort: バックアップが取れなくても続行
    match write_timestamped_backup(path, bytes, None).await {
        Ok(bak) => tracing::info!("[settings] wrote timestamped backup: {}", bak.display()),
        Err(berr) => tracing::warn!("[settings] backup write failed: {berr}"),
    }
    if let Some(recovered) = try_recover_from_v11_backup(path).await {
        tracing::warn!("[settings] recovered settings from v11 snapshot after parse failure");
        return recovered;
    }
    Settings::default()
}

/// 隣接する `settings.v11.bak` を読み戻す。バックアップが無い / 読めない / それ自体も
/// parse 不能なら `None` を返し、caller は default にフォールバックする。
///
/// `settings_path` を引数で受け取ることで、グローバル `config_paths` に依存せず tempdir で
/// ユニットテストできる。
async fn try_recover_from_v11_backup(settings_path: &Path) -> Option<Settings> {
    let backup = settings_path.parent()?.join("settings.v11.bak");
    let bytes = fs::read(&backup).await.ok()?;
    match serde_json::from_slice::<Settings>(&bytes) {
        Ok(s) => Some(s),
        Err(e) => {
            tracing::warn!(
                "[settings] v11 snapshot {} also failed to parse: {e}",
                backup.display()
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// parse 可能な v11 スナップショットがあれば、その設定値を読み戻す。
    #[tokio::test]
    async fn recover_from_v11_backup_loads_valid_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let settings_path = dir.path().join("settings.json");
        let backup = dir.path().join("settings.v11.bak");
        let snapshot = json!({
            "schemaVersion": 11,
            "language": "en",
            "theme": "midnight",
            "claudeCwd": "/home/u/proj",
        });
        tokio::fs::write(&backup, serde_json::to_vec(&snapshot).unwrap())
            .await
            .unwrap();
        let recovered = try_recover_from_v11_backup(&settings_path)
            .await
            .expect("should recover from v11 snapshot");
        assert_eq!(recovered.schema_version, Some(11));
        assert_eq!(recovered.language, "en");
        assert_eq!(recovered.theme, "midnight");
        assert_eq!(recovered.claude_cwd, "/home/u/proj");
    }

    /// バックアップが存在しなければ `None` を返す (caller は default にフォールバック)。
    #[tokio::test]
    async fn recover_from_v11_backup_returns_none_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        let settings_path = dir.path().join("settings.json");
        assert!(try_recover_from_v11_backup(&settings_path).await.is_none());
    }

    /// バックアップ自体が壊れている (= 非 JSON) 場合も `None` を返し、panic しない。
    #[tokio::test]
    async fn recover_from_v11_backup_returns_none_for_corrupt_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let settings_path = dir.path().join("settings.json");
        let backup = dir.path().join("settings.v11.bak");
        tokio::fs::write(&backup, b"{ this is not json").await.unwrap();
        assert!(try_recover_from_v11_backup(&settings_path).await.is_none());
    }

    /// 復旧フルパス: 破損原本は退避され、v11 スナップショットの値が返る。
    #[tokio::test]
    async fn recover_after_parse_failure_prefers_v11_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let corrupt = b"{ broken json";
        tokio::fs::write(&path, corrupt).await.unwrap();
        let snapshot = json!({ "schemaVersion": 11, "theme": "light" });
        tokio::fs::write(
            dir.path().join("settings.v11.bak"),
            serde_json::to_vec(&snapshot).unwrap(),
        )
        .await
        .unwrap();
        let err = serde_json::from_slice::<Settings>(corrupt).unwrap_err();
        let recovered = recover_after_parse_failure(&path, corrupt, err).await;
        assert_eq!(recovered.schema_version, Some(11));
        assert_eq!(recovered.theme, "light");
    }

    /// v11 スナップショットが無ければ default にフォールバックする。
    #[tokio::test]
    async fn recover_after_parse_failure_falls_back_to_default() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let corrupt = b"not json at all";
        tokio::fs::write(&path, corrupt).await.unwrap();
        let err = serde_json::from_slice::<Settings>(corrupt).unwrap_err();
        let recovered = recover_after_parse_failure(&path, corrupt, err).await;
        // default 値
        assert_eq!(recovered.theme, "claude-dark");
        assert_eq!(recovered.language, "ja");
    }
}

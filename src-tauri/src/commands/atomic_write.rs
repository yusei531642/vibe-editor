// Atomic write helper
//
// Issue #37: settings.json / team-history.json / ~/.claude.json などの永続ファイルを
// `tokio::fs::write()` で直接上書きすると、書き込み中のクラッシュ/電源断で半端な JSON
// (空 or 途中で切れた) が残り、次回起動時に parse 失敗 → デフォルト巻き戻り、という事故が
// 起きる。特に `~/.claude.json` は他アプリと共有なのでユーザー影響が大きい。
//
// 対策: `<target>.tmp.<pid>.<rand>` に書き、fsync して rename で atomic 置換する。
// POSIX も Windows も rename は same-volume なら atomic (Windows は MoveFileEx + REPLACE_EXISTING)。

use anyhow::Result;
use std::path::Path;
use tokio::fs;
use tokio::io::AsyncWriteExt;

/// 指定 path にバイト列を atomic に書き込む。親ディレクトリは自動作成。
pub async fn atomic_write(target: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).await?;
    }
    // temp ファイル名は同ディレクトリ内に (rename が atomic になる条件)
    // Issue #169: 旧 tmp 名 `.{file}.tmp.{pid}.{nanos}` は同プロセス内の同時 atomic_write が
    // 同一ナノ秒に揃うと衝突しうる (settings リサイズ + role profile save 並行時など)。
    // uuid v4 を混ぜて衝突確率を実質ゼロにする。
    let tmp = {
        let file_name = target
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "vibe.tmp".to_string());
        let pid = std::process::id();
        let unique = uuid::Uuid::new_v4().simple().to_string();
        let tmp_name = format!(".{file_name}.tmp.{pid}.{unique}");
        target
            .parent()
            .map(|p| p.join(tmp_name.clone()))
            .unwrap_or_else(|| Path::new(&tmp_name).to_path_buf())
    };

    // 書き込み + fsync
    {
        let mut f = fs::File::create(&tmp).await?;
        f.write_all(bytes).await?;
        f.flush().await?;
        // sync_all で metadata も含めてディスクへ flush
        f.sync_all().await.ok();
    }

    // rename で atomic 置換。Windows は同 volume 内なら既存ファイルの置換もアトミック
    // (Rust の rename は内部で MoveFileExW + MOVEFILE_REPLACE_EXISTING を呼ぶ)。
    if let Err(e) = fs::rename(&tmp, target).await {
        // 失敗時は temp を掃除して error を上げる (target は旧状態のまま残るので安全)
        let _ = fs::remove_file(&tmp).await;
        return Err(e.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn atomic_write_creates_file_with_content() {
        let dir = std::env::temp_dir().join(format!(
            "vibe-atomic-test-{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&dir).await;
        let target = dir.join("example.json");
        atomic_write(&target, b"{\"a\":1}").await.unwrap();
        let got = fs::read(&target).await.unwrap();
        assert_eq!(&got, b"{\"a\":1}");
        let _ = fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn atomic_write_replaces_existing() {
        let dir = std::env::temp_dir().join(format!(
            "vibe-atomic-test-replace-{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&dir).await;
        let target = dir.join("example.json");
        atomic_write(&target, b"v1").await.unwrap();
        atomic_write(&target, b"v2").await.unwrap();
        let got = fs::read(&target).await.unwrap();
        assert_eq!(&got, b"v2");
        let _ = fs::remove_dir_all(&dir).await;
    }
}

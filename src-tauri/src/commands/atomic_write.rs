// Atomic write helper
//
// Issue #37: settings.json / team-history.json / ~/.claude.json などの永続ファイルを
// `tokio::fs::write()` で直接上書きすると、書き込み中のクラッシュ/電源断で半端な JSON
// (空 or 途中で切れた) が残り、次回起動時に parse 失敗 → デフォルト巻き戻り、という事故が
// 起きる。特に `~/.claude.json` は他アプリと共有なのでユーザー影響が大きい。
//
// 対策: `<target>.tmp.<pid>.<rand>` に書き、fsync して rename で atomic 置換する。
// POSIX も Windows も rename は same-volume なら atomic (Windows は MoveFileEx + REPLACE_EXISTING)。

use anyhow::{anyhow, Result};
use std::path::{Path, PathBuf};
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
        let file_name = target.file_name().map_or_else(
            || "vibe.tmp".to_string(),
            |s| s.to_string_lossy().into_owned(),
        );
        let pid = std::process::id();
        let unique = uuid::Uuid::new_v4().simple().to_string();
        let tmp_name = format!(".{file_name}.tmp.{pid}.{unique}");
        match target.parent() {
            Some(p) => p.join(&tmp_name),
            None => PathBuf::from(&tmp_name),
        }
    };

    // Issue #187 (Security): tmp が攻撃者によって symlink 先置きされている可能性に備え、
    // O_CREAT | O_EXCL 相当の create_new=true で開く (既存があれば失敗)。
    // 加えて Unix では O_NOFOLLOW を付けて symlink を follow させない。
    {
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            // O_NOFOLLOW (linux: 0x20000, macOS: 0x100). libc クレートを使わずに数値で指定するのは
            // 非互換になりやすいので tokio が提供する custom_flags 経由を採用。
            // libc が無い場合でも O_EXCL で symlink → target file 上書きはほぼ防げる。
            #[cfg(target_os = "linux")]
            opts.custom_flags(0x20000); // O_NOFOLLOW (Linux)
            #[cfg(target_os = "macos")]
            opts.custom_flags(0x0100); // O_NOFOLLOW (macOS / BSD)
        }
        let mut f = match opts.open(&tmp).await {
            Ok(f) => f,
            Err(e) => {
                return Err(anyhow!("atomic_write open tmp failed: {e}"));
            }
        };
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
        let dir = std::env::temp_dir().join(format!("vibe-atomic-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir).await;
        let target = dir.join("example.json");
        atomic_write(&target, b"{\"a\":1}").await.unwrap();
        let got = fs::read(&target).await.unwrap();
        assert_eq!(&got, b"{\"a\":1}");
        let _ = fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn atomic_write_replaces_existing() {
        let dir =
            std::env::temp_dir().join(format!("vibe-atomic-test-replace-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir).await;
        let target = dir.join("example.json");
        atomic_write(&target, b"v1").await.unwrap();
        atomic_write(&target, b"v2").await.unwrap();
        let got = fs::read(&target).await.unwrap();
        assert_eq!(&got, b"v2");
        let _ = fs::remove_dir_all(&dir).await;
    }
}

// Issue #37: 設定 / team-history / ~/.claude.json などユーザー設定ファイルの書き込みは
// 旧実装が直接 `tokio::fs::write()` で上書きしていたため、プロセスクラッシュ / 電源断で
// ファイルが truncate → 次回起動時に JSON parse 失敗 → DEFAULT に戻る事故があり得た。
//
// このモジュールは「同ディレクトリの temp → fsync → rename」方式でアトミックに置換する。
// rename が atomic なのは同一 filesystem 内に限るので、temp は常に target と同一ディレクトリに作る。

use std::path::Path;
use tokio::fs;
use tokio::io::AsyncWriteExt;

pub async fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "no parent"))?;
    fs::create_dir_all(parent).await?;
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("atomic");
    let tmp = parent.join(format!(".{file_name}.tmp-{}", uuid::Uuid::new_v4()));
    {
        let mut f = fs::File::create(&tmp).await?;
        f.write_all(bytes).await?;
        f.flush().await?;
        let _ = f.sync_all().await;
    }
    match fs::rename(&tmp, path).await {
        Ok(_) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&tmp).await;
            Err(e)
        }
    }
}

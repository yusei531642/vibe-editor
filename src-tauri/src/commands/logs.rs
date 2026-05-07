// logs.* command — 設定モーダルからログを閲覧する用 (Issue #326)
//
// `~/.vibe-editor/logs/vibe-editor.log` の末尾だけを UTF-8 で読み出して renderer に返す。
// ログファイル自体は `lib.rs` の `init_logging()` 内で tracing-appender が書き出している。

use serde::Serialize;
use std::path::PathBuf;
use tokio::fs;

/// `~/.vibe-editor/logs/` ディレクトリ
pub fn log_dir() -> PathBuf {
    crate::util::config_paths::logs_dir()
}

/// ログファイル本体のパス
pub fn log_file_path() -> PathBuf {
    log_dir().join("vibe-editor.log")
}

/// renderer に返す read_log_tail 応答。serde が camelCase に変換する。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadLogTailResponse {
    /// ログ末尾の UTF-8 文字列。ファイル先頭から読んだ場合 truncated=false。
    pub content: String,
    /// 表示用の絶対パス
    pub path: String,
    /// max_bytes でクリップしたか (= ログがそれ以上長い)
    pub truncated: bool,
    /// ファイルが存在しない / size=0 のとき true。content は空。
    pub empty: bool,
}

/// ログファイル末尾の最大 `max_bytes` バイトを UTF-8 lossy で読む。
///
/// - max_bytes=0 や指定なしは 256KB にデフォルト。
/// - ファイルが存在しない場合は empty=true で空文字列を返す (エラーにはしない)。
/// - ログは tracing-appender が UTF-8 で書いているので lossy decode で十分。
#[tauri::command]
pub async fn logs_read_tail(
    max_bytes: Option<u64>,
) -> crate::commands::error::CommandResult<ReadLogTailResponse> {
    const DEFAULT_MAX: u64 = 256 * 1024;
    let cap = max_bytes.filter(|n| *n > 0).unwrap_or(DEFAULT_MAX);
    let path = log_file_path();
    let path_str = path.to_string_lossy().to_string();

    // metadata 取得 (ファイル不在は empty=true で正常終了)
    let Ok(meta) = fs::metadata(&path).await else {
        return Ok(ReadLogTailResponse {
            content: String::new(),
            path: path_str,
            truncated: false,
            empty: true,
        });
    };
    let size = meta.len();
    if size == 0 {
        return Ok(ReadLogTailResponse {
            content: String::new(),
            path: path_str,
            truncated: false,
            empty: true,
        });
    }

    let bytes = if size <= cap {
        // 全部読める
        fs::read(&path).await.map_err(|e| e.to_string())?
    } else {
        // 末尾だけ読む
        use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
        let mut f = fs::File::open(&path).await.map_err(|e| e.to_string())?;
        f.seek(SeekFrom::End(-(cap as i64)))
            .await
            .map_err(|e| e.to_string())?;
        let mut buf = Vec::with_capacity(cap as usize);
        f.take(cap)
            .read_to_end(&mut buf)
            .await
            .map_err(|e| e.to_string())?;
        buf
    };

    // 行頭が途中切れになっていたら捨てる (見栄え)
    let mut content = String::from_utf8_lossy(&bytes).to_string();
    if size > cap {
        if let Some(idx) = content.find('\n') {
            content = content[idx + 1..].to_string();
        }
    }

    Ok(ReadLogTailResponse {
        content,
        path: path_str,
        truncated: size > cap,
        empty: false,
    })
}

/// ログディレクトリを OS のファイルマネージャで開く。
/// tauri-plugin-opener を使用 (lib.rs で plugin 登録済み)。
#[tauri::command]
pub async fn logs_open_dir(app: tauri::AppHandle) -> crate::commands::error::CommandResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let dir = log_dir();
    // ディレクトリが無ければ best-effort で作成 (初回起動直後対策)
    if let Err(e) = fs::create_dir_all(&dir).await {
        tracing::warn!("[logs] mkdir failed: {e}");
    }
    let path_str = dir.to_string_lossy().to_string();
    Ok(app
        .opener()
        .open_path(path_str, None::<&str>)
        .map_err(|e| e.to_string())?)
}

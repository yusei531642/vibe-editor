// logs.* command — 設定モーダルからログを閲覧する用 (Issue #326 / #643)
//
// `~/.vibe-editor/logs/vibe-editor.log.YYYY-MM-DD` の末尾だけを UTF-8 で読み出して renderer に返す。
// ログファイル自体は `lib.rs` の `init_logging()` 内で tracing-appender が日次回転で書き出している。

use serde::Serialize;
use std::path::{Path, PathBuf};
use tokio::fs;

/// `~/.vibe-editor/logs/` ディレクトリ
pub fn log_dir() -> PathBuf {
    crate::util::config_paths::logs_dir()
}

/// ログファイル本体のパス。
///
/// Issue #643: 日次回転に切り替えた後、実ファイルは `vibe-editor.log.YYYY-MM-DD` 形式に
/// なるため、このパス自体には何も書かれない。`team_diagnostics` の `serverLogPath` 等で
/// ベース位置の目印として残してある。実ファイルを読むときは `latest_log_file()` を使う。
///
/// 現状 in-tree で直接の caller は無いが、外部診断ツール / 将来の IPC コマンドが
/// 「ログ書き出し先のベースパス」を尋ねるときの公開 API として保持する。
#[allow(dead_code)]
pub fn log_file_path() -> PathBuf {
    log_dir().join("vibe-editor.log")
}

/// Issue #643: ログディレクトリ内の `vibe-editor.log*` のうち mtime 最新のものを返す。
///
/// - 候補が無ければベース位置 (`vibe-editor.log`) を返す。呼び出し側は metadata 取得失敗を
///   `empty=true` として扱うので、存在しない path でも問題なし。
/// - 旧無回転 `vibe-editor.log` 単体ファイル (Issue #326 互換) も `vibe-editor.log*` に含むので、
///   起動時 sweep で消えるまでの過渡期にも正しく表示できる。
fn latest_log_file(dir: &Path) -> PathBuf {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return dir.join("vibe-editor.log");
    };
    let mut best: Option<(PathBuf, std::time::SystemTime)> = None;
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if !ft.is_file() {
            continue;
        }
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if !name_str.starts_with("vibe-editor.log") {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let modified = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        match &best {
            Some((_, prev)) if *prev >= modified => {}
            _ => best = Some((entry.path(), modified)),
        }
    }
    best.map(|(p, _)| p)
        .unwrap_or_else(|| dir.join("vibe-editor.log"))
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
    // Issue #643: 日次回転後の最新ファイル (`vibe-editor.log.YYYY-MM-DD`) を選んで読む。
    let path = latest_log_file(&log_dir());
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
#[cfg(test)]
mod tests {
    use super::latest_log_file;
    use std::fs;
    use std::time::{Duration, SystemTime};

    /// Issue #643: 日次回転後の `vibe-editor.log.YYYY-MM-DD` のうち最新世代を選ぶ。
    #[test]
    fn latest_log_file_picks_newest_dated_log() {
        let dir = tempfile::tempdir().expect("tempdir");

        let oldest = dir.path().join("vibe-editor.log.2026-05-01");
        let newest = dir.path().join("vibe-editor.log.2026-05-09");
        let middle = dir.path().join("vibe-editor.log.2026-05-05");
        let unrelated = dir.path().join("audit.log"); // 触らない (prefix 不一致)
        for f in [&oldest, &newest, &middle, &unrelated] {
            fs::write(f, b"x").unwrap();
        }

        // mtime を明示的にずらして「最新 = newest」を保証 (CI のファイル作成順序差を回避)。
        let now = SystemTime::now();
        for (f, ago_days) in [(&oldest, 8u64), (&newest, 0), (&middle, 4), (&unrelated, 0)] {
            let t = now - Duration::from_secs(60 * 60 * 24 * ago_days);
            fs::File::options()
                .write(true)
                .open(f)
                .unwrap()
                .set_modified(t)
                .unwrap();
        }

        let picked = latest_log_file(dir.path());
        assert_eq!(picked, newest);
    }

    /// 候補が空のとき、ベース位置を返す。呼び出し側はそれを metadata 取得失敗 = empty と扱う。
    #[test]
    fn latest_log_file_falls_back_to_base_when_empty() {
        let dir = tempfile::tempdir().expect("tempdir");
        let picked = latest_log_file(dir.path());
        assert_eq!(picked, dir.path().join("vibe-editor.log"));
    }

    /// 旧無回転 `vibe-editor.log` 単体ファイル (Issue #326 互換) も候補に含む。
    #[test]
    fn latest_log_file_includes_legacy_unrotated_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let legacy = dir.path().join("vibe-editor.log");
        fs::write(&legacy, b"legacy content").unwrap();

        let picked = latest_log_file(dir.path());
        assert_eq!(picked, legacy);
    }
}

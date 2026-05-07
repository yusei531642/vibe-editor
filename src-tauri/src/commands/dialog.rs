// dialog.* command — 旧 src/main/ipc/dialog.ts に対応
//
// tauri-plugin-dialog でファイル/フォルダ選択、自前で空フォルダ判定。

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;

#[tauri::command]
pub async fn dialog_open_folder(app: AppHandle, title: Option<String>) -> Option<String> {
    let (tx, rx) = oneshot::channel();
    let mut builder = app.dialog().file();
    if let Some(t) = title {
        builder = builder.set_title(&t);
    }
    builder.pick_folder(move |result| {
        let _ = tx.send(result.map(|p| p.to_string()));
    });
    rx.await.ok().flatten()
}

#[tauri::command]
pub async fn dialog_open_file(app: AppHandle, title: Option<String>) -> Option<String> {
    let (tx, rx) = oneshot::channel();
    let mut builder = app.dialog().file();
    if let Some(t) = title {
        builder = builder.set_title(&t);
    }
    builder.pick_file(move |result| {
        let _ = tx.send(result.map(|p| p.to_string()));
    });
    rx.await.ok().flatten()
}

/// Issue #137 (Security): 任意 path をクエリして OS / FS の fingerprint に使われるのを防ぐため、
/// 「ユーザーホーム配下」または「現在のプロジェクトルート / その祖先」だけを許可する。
/// /etc, /sys, /proc, C:\Windows などのシステム領域は早期 reject。
fn is_path_safe_to_query(path: &std::path::Path) -> bool {
    let Ok(canon) = path.canonicalize() else {
        return false; // 存在しないパスも reject (fingerprint 防止)
    };
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    let home_canon = home.canonicalize().unwrap_or(home);
    if canon.starts_with(&home_canon) {
        return true;
    }
    // システム領域の denylist (ホーム外でも見やすい場所)
    #[cfg(windows)]
    {
        let lower = canon.to_string_lossy().to_lowercase();
        if lower.starts_with("c:\\windows")
            || lower.starts_with("c:\\program files")
            || lower.starts_with("c:\\programdata")
        {
            return false;
        }
    }
    #[cfg(unix)]
    {
        let lower = canon.to_string_lossy().to_string();
        for prefix in [
            "/etc", "/sys", "/proc", "/dev", "/var", "/usr", "/bin", "/sbin", "/boot",
        ] {
            if lower.starts_with(prefix) {
                return false;
            }
        }
    }
    // それ以外 (ホーム外で denylist にも該当しない) は許可しない (fail-closed)
    false
}

/// Issue #60: 旧実装は読み取り失敗時に `true` (= 空) を返していたため、権限エラー /
/// path 不存在を「空」と取り違え、呼び出し側の警告ロジックが誤判定していた。
///
/// 新方針: fail-closed (中身があるかもしれないとみなす)。
/// - 読み取り成功 + next_entry が None → 空 (true)
/// - 読み取り失敗 or エントリ検出 → false ("OK as empty" と判定させない)
///
/// Issue #137: 加えて、ホーム外/システム領域のパスは fingerprint 防止のため拒否する。
#[tauri::command]
pub async fn dialog_is_folder_empty(folder_path: String) -> bool {
    if !is_path_safe_to_query(std::path::Path::new(&folder_path)) {
        tracing::warn!(
            "[dialog_is_folder_empty] rejecting query outside allowed area: {folder_path:?}"
        );
        return false;
    }
    let mut rd = match tokio::fs::read_dir(&folder_path).await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(
                "[dialog_is_folder_empty] read_dir failed for {folder_path:?}: {e} — treating as non-empty"
            );
            return false;
        }
    };
    matches!(rd.next_entry().await, Ok(None))
}

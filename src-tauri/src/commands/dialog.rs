// dialog.* command — 旧 src/main/ipc/dialog.ts に対応
//
// tauri-plugin-dialog でファイル/フォルダ選択、自前で空フォルダ判定。

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;

#[tauri::command]
pub async fn dialog_open_folder(
    app: AppHandle,
    title: Option<String>,
) -> Option<String> {
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
pub async fn dialog_open_file(
    app: AppHandle,
    title: Option<String>,
) -> Option<String> {
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

/// Issue #60: 旧実装は読み取り失敗時に `true` (= 空) を返していたため、権限エラー /
/// path 不存在を「空」と取り違え、呼び出し側の警告ロジックが誤判定していた。
///
/// 新方針: fail-closed (中身があるかもしれないとみなす)。
/// - 読み取り成功 + next_entry が None → 空 (true)
/// - 読み取り失敗 or エントリ検出 → false ("OK as empty" と判定させない)
///
/// ユーザーが「権限無しで空扱い」されるケースを潰す。本当に「読めない」を区別したい
/// 呼び出し側は dialog_read_dir 等を別途用意すること (現時点では不要)。
#[tauri::command]
pub async fn dialog_is_folder_empty(folder_path: String) -> bool {
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

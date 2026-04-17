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

#[tauri::command]
pub async fn dialog_is_folder_empty(folder_path: String) -> bool {
    let mut rd = match tokio::fs::read_dir(&folder_path).await {
        Ok(r) => r,
        Err(_) => return true,
    };
    matches!(rd.next_entry().await, Ok(None))
}

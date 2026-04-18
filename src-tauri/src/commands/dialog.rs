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

#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FolderEmptyResult {
    pub ok: bool,
    pub empty: bool,
    pub error: Option<String>,
}

/// Issue #60: 読み取り失敗を「空」と混同しないよう、ok フラグを返す。
/// 呼び出し側は `ok=false` のとき空扱いせず警告を出すべき。
#[tauri::command]
pub async fn dialog_is_folder_empty(folder_path: String) -> FolderEmptyResult {
    match tokio::fs::read_dir(&folder_path).await {
        Ok(mut rd) => {
            let empty = matches!(rd.next_entry().await, Ok(None));
            FolderEmptyResult {
                ok: true,
                empty,
                error: None,
            }
        }
        Err(e) => FolderEmptyResult {
            ok: false,
            // 権限エラー等は「空不明」= 安全側倒し (empty=false)。
            empty: false,
            error: Some(e.to_string()),
        },
    }
}

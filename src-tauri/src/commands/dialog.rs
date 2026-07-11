// dialog.* command — 旧 src/main/ipc/dialog.ts に対応
//
// tauri-plugin-dialog でファイル/フォルダ選択、自前で空フォルダ判定。

use serde::Deserialize;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;

/// Issue #820: renderer から渡される拡張子フィルタ。
/// `extensions` はドット無し (例: ["png", "jpg"])。shared.ts の `DialogFileFilter` と同期。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DialogFileFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

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
pub async fn dialog_open_file(
    app: AppHandle,
    title: Option<String>,
    filters: Option<Vec<DialogFileFilter>>,
) -> Option<String> {
    let (tx, rx) = oneshot::channel();
    let mut builder = app.dialog().file();
    if let Some(t) = title {
        builder = builder.set_title(&t);
    }
    for filter in filters.unwrap_or_default() {
        let exts: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
        builder = builder.add_filter(&filter.name, &exts);
    }
    builder.pick_file(move |result| {
        let _ = tx.send(result.map(|p| p.to_string()));
    });
    rx.await.ok().flatten()
}

/// Issue #137 (Security): 任意 path をクエリして OS / FS の fingerprint に使われるのを防ぐため、
/// 「ユーザーホーム配下」または「現在のプロジェクトルート / その祖先」だけを許可する。
/// /etc, /sys, /proc, C:\Windows などのシステム領域は早期 reject。
async fn is_path_safe_to_query(path: &std::path::Path) -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    is_path_safe_to_query_with_home(path, &home).await
}

async fn is_path_safe_to_query_with_home(path: &std::path::Path, home: &std::path::Path) -> bool {
    // Issue #1149: path と home は独立して解決できるため並列に待ち、Tokio worker を
    // std::fs::canonicalize でブロックしない。どちらか一方でも失敗したら fail-closed。
    let (path_result, home_result) =
        tokio::join!(tokio::fs::canonicalize(path), tokio::fs::canonicalize(home));
    let (Ok(canon), Ok(home_canon)) = (path_result, home_result) else {
        return false; // 存在しないパスも reject (fingerprint 防止)
    };
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
    if !is_path_safe_to_query(std::path::Path::new(&folder_path)).await {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn safe_query_allows_existing_home_descendant() {
        let home = tempfile::tempdir().expect("home");
        let child = home.path().join("project");
        tokio::fs::create_dir(&child).await.expect("child");

        assert!(is_path_safe_to_query_with_home(&child, home.path()).await);
    }

    #[tokio::test]
    async fn safe_query_rejects_missing_path_or_home() {
        let home = tempfile::tempdir().expect("home");
        let missing_path = home.path().join("missing");
        assert!(!is_path_safe_to_query_with_home(&missing_path, home.path()).await);

        let existing = tempfile::tempdir().expect("existing");
        let missing_home = existing.path().join("missing-home");
        assert!(!is_path_safe_to_query_with_home(existing.path(), &missing_home).await);
    }

    #[tokio::test]
    async fn safe_query_rejects_home_external_and_system_paths() {
        let home = tempfile::tempdir().expect("home");
        let outside = tempfile::tempdir().expect("outside");
        assert!(!is_path_safe_to_query_with_home(outside.path(), home.path()).await);

        #[cfg(unix)]
        assert!(!is_path_safe_to_query_with_home(std::path::Path::new("/etc"), home.path()).await);

        #[cfg(windows)]
        if let Some(windows_dir) = std::env::var_os("WINDIR") {
            assert!(
                !is_path_safe_to_query_with_home(std::path::Path::new(&windows_dir), home.path(),)
                    .await
            );
        }
    }

    #[tokio::test]
    async fn folder_empty_keeps_fail_closed_contract() {
        let home = dirs::home_dir().expect("home directory");
        let root = tempfile::Builder::new()
            .prefix("vibe-dialog-empty-")
            .tempdir_in(home)
            .expect("home tempdir");

        assert!(dialog_is_folder_empty(root.path().to_string_lossy().into_owned()).await);
        tokio::fs::write(root.path().join("entry"), b"x")
            .await
            .expect("entry");
        assert!(!dialog_is_folder_empty(root.path().to_string_lossy().into_owned()).await);
        assert!(
            !dialog_is_folder_empty(root.path().join("missing").to_string_lossy().into_owned())
                .await
        );
    }
}

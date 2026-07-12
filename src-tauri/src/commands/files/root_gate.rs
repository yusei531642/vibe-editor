//! Issue #1193: files_* コマンド共通の project root 認可ゲート。

use crate::commands::authz::ProjectRoot;
use crate::commands::error::CommandResult;
use crate::state::AppState;
use tauri::{AppHandle, Manager};

/// Issue #932 / #954 / #963: renderer 由来の `project_root` を検証する files_* 共通ゲート。
///
/// 当初 (#932) は write 系を active project との厳格一致で守っていたが、multi-root
/// workspace (settings.workspaceFolders, Issue #4) の追加ルート内ファイル操作
/// (新規作成 / リネーム / 削除 / 貼り付け) まで拒否してしまう退行があった (#963)。
/// read 側 (#954) と同じ `assert_readable_project_root` (active root ∪ settings.json
/// SSOT の workspaceFolders、workspace folder には `is_safe_watch_root` 検証を追加要求)
/// に read/write とも統一する。
///
/// async command が `State` (参照入力) を取ると Tauri が `Result` 返却を強制するため、非 `Result`
/// を返す既存 FS コマンド契約 (renderer は構造体をそのまま受ける) を保てない。owned/'static な
/// `AppHandle` 経由で state を引くことでこの制約を回避し、既存の戻り値型を維持したまま
/// ゲートを各コマンド先頭に挿せるようにする。
pub(crate) async fn assert_workspace_project_root_via(
    app: &AppHandle,
    project_root: &str,
) -> CommandResult<ProjectRoot> {
    let state = app.state::<AppState>();
    crate::commands::authz::assert_readable_project_root(
        &state.project_root,
        &state.project_root_identity,
        project_root,
    )
    .await
}

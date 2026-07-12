//! `team_history_list` の認可境界とread path。

use super::{
    ensure_loaded, reconcile_external_changes, store_path, TeamHistoryEntry, TeamHistoryStore,
    STORE,
};
use crate::commands::error::CommandResult;
use crate::commands::project_authority::ProjectRootIdentity;
use crate::state::AppState;
use arc_swap::ArcSwapOption;
use std::collections::HashSet;
use tauri::State;

#[tauri::command]
pub async fn team_history_list(
    state: State<'_, AppState>,
    project_root: String,
) -> CommandResult<Vec<TeamHistoryEntry>> {
    team_history_list_via(
        &state.project_root,
        &state.project_root_identity,
        project_root,
        team_history_list_authorized,
    )
    .await
}

/// strict active-root gateと後続STORE readerの順序を固定する。readerだけを注入可能にし、
/// 実gate自体は差し替えられないため、拒否requestはSTORE lock/disk I/Oへ進まない。
pub(crate) async fn team_history_list_via<R, Reader, Fut>(
    project_root_slot: &ArcSwapOption<String>,
    project_root_identity_slot: &ArcSwapOption<ProjectRootIdentity>,
    project_root: String,
    reader: Reader,
) -> CommandResult<R>
where
    Reader: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = R>,
{
    let authorized = crate::commands::authz::assert_active_project_root_with_raw(
        project_root_slot,
        project_root_identity_slot,
        &project_root,
    )
    .await?;
    // Store lock前に同一authz snapshotのactive raw keyを確定する。requested rawをreaderへ
    // 渡さず、key生成でもI/Oをしないため、待機中のsymlink retargetでidentityは変化しない。
    let target = authorized.active_raw_key();
    Ok(reader(target).await)
}

async fn team_history_list_authorized(target: String) -> Vec<TeamHistoryEntry> {
    // 拒否requestはここへ到達しない。STORE lockと全disk/cache処理はgateより後に置く。
    let mut store = STORE.lock().await;
    ensure_loaded(&mut store).await;
    let path = store_path();
    let TeamHistoryStore { cache, sync_state } = &mut *store;
    let all = cache.as_mut().expect("ensured");
    let _ = reconcile_external_changes(&path, all, sync_state, &HashSet::new()).await;
    filter_team_history_entries(&target, all)
}

/// 既存entryのraw pathをI/Oなしで比較用に整形する。
///
/// entryをここでcanonicalizeすると、保存後にsymlinkがretargetされたとき「foreignだった
/// 履歴」がactive rootと再解決されて見えてしまう。disk formatはraw pathのまま維持しつつ、
/// gate時active raw snapshotと同じ表記のentryだけを安全側で返す。
fn normalize_stored_project_root(raw: &str) -> String {
    let normalized = raw.replace('\\', "/");
    let stripped = normalized.trim_end_matches('/');
    if cfg!(windows) {
        stripped.to_lowercase()
    } else {
        stripped.to_string()
    }
}

/// entry側はI/Oなしで正規化し、selector identityだけgate時canonical snapshotへ固定する。
pub(crate) fn filter_team_history_entries(
    target: &str,
    entries: &[TeamHistoryEntry],
) -> Vec<TeamHistoryEntry> {
    entries
        .iter()
        .filter(|entry| normalize_stored_project_root(&entry.project_root) == target)
        .cloned()
        .collect()
}

//! `team_history_list` の認可境界とread path。

use super::{
    ensure_loaded, reconcile_external_changes, store_path, ActiveHistoryScope, TeamHistoryEntry,
    TeamHistoryStore, STORE,
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
    Reader: FnOnce(ActiveHistoryScope) -> Fut,
    Fut: std::future::Future<Output = R>,
{
    let authorized = crate::commands::authz::assert_active_project_root_with_raw(
        project_root_slot,
        project_root_identity_slot,
        &project_root,
    )
    .await?;
    // Store lock前に同一authz snapshotのactive raw key + approval identityを確定する。
    // requested rawをreaderへ渡さず、key生成でもI/Oをしないため、待機中のsymlink retargetで
    // identityは変化しない (Issue #1147 / #1192)。
    let scope = ActiveHistoryScope {
        raw_key: authorized.active_raw_key(),
        identity: authorized.approved_identity().clone(),
    };
    Ok(reader(scope).await)
}

async fn team_history_list_authorized(scope: ActiveHistoryScope) -> Vec<TeamHistoryEntry> {
    // 拒否requestはここへ到達しない。STORE lockと全disk/cache処理はgateより後に置く。
    let mut store = STORE.lock().await;
    ensure_loaded(&mut store).await;
    let path = store_path();
    let TeamHistoryStore { cache, sync_state } = &mut *store;
    let all = cache.as_mut().expect("ensured");
    let _ = reconcile_external_changes(&path, all, sync_state, &HashSet::new()).await;
    filter_team_history_entries(&scope, all)
}

/// 既存entryのraw pathをI/Oなしで比較用に整形する。
///
/// entryをここでcanonicalizeすると、保存後にsymlinkがretargetされたとき「foreignだった
/// 履歴」がactive rootと再解決されて見えてしまう。disk formatはraw pathのまま維持しつつ、
/// gate時active raw snapshotと同じ表記のentryだけを安全側で返す。
pub(crate) fn normalize_stored_project_root(raw: &str) -> String {
    let normalized = raw.replace('\\', "/");
    let stripped = normalized.trim_end_matches('/');
    if cfg!(windows) {
        stripped.to_lowercase()
    } else {
        stripped.to_string()
    }
}

/// entry側はI/Oなしで正規化し、selector identityだけgate時canonical snapshotへ固定する。
///
/// Issue #1192: raw key 一致に加えて、entry が identity snapshot を持つ場合は gate 時
/// approval identity との完全一致まで要求する。directory 置換 / symlink retarget 後に
/// path 表記が同じでも、別 filesystem object 時代の履歴を現 project へ帰属させない。
/// None は #1192 以前の legacy entry で、互換のため raw key 一致だけで通す (次の save で
/// 現 identity が刻印されて卒業する)。
pub(crate) fn filter_team_history_entries(
    scope: &ActiveHistoryScope,
    entries: &[TeamHistoryEntry],
) -> Vec<TeamHistoryEntry> {
    entries
        .iter()
        .filter(|entry| {
            normalize_stored_project_root(&entry.project_root) == scope.raw_key
                && entry
                    .project_identity
                    .as_ref()
                    .is_none_or(|identity| identity == &scope.identity)
        })
        .cloned()
        .collect()
}

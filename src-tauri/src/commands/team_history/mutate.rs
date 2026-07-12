//! Issue #1194: team history mutation (save / save_batch / delete) の認可境界と write path。
//!
//! `team_history_list` (#1147, `list.rs`) と同じ「strict active-root gate → 後続 writer」の
//! 順序固定を mutation にも適用する。拒否された request は STORE lock / disk read-write /
//! orchestration hydration のいずれにも到達しない。entry が持ち込む `project_root` は
//! gate 時 active raw snapshot key との一致まで検証し、alias 表記や mixed-project batch は
//! fail-closed に拒否する。

use super::list::normalize_stored_project_root;
use super::{
    apply_with_disk_commit, ensure_loaded, hydrate_orchestration_summary, merge_entry,
    reconcile_external_changes, store_path, validate_entry_size, MutationResult,
    TeamHistoryEntry, TeamHistoryStore, STORE,
};
use crate::commands::error::{CommandError, CommandResult};
use crate::commands::project_authority::ProjectRootIdentity;
use crate::state::AppState;
use arc_swap::ArcSwapOption;
use std::collections::HashSet;
use tauri::State;

#[tauri::command]
pub async fn team_history_save(
    state: State<'_, AppState>,
    entry: TeamHistoryEntry,
) -> CommandResult<MutationResult> {
    let gate_root = entry.project_root.clone();
    team_history_mutation_via(
        &state.project_root,
        &state.project_root_identity,
        &[gate_root.as_str()],
        move |target| save_authorized(target, entry),
    )
    .await
}

/// Issue #132: 複数チームの保存を 1 IPC + 1 disk write にまとめる。
#[tauri::command]
pub async fn team_history_save_batch(
    state: State<'_, AppState>,
    entries: Vec<TeamHistoryEntry>,
) -> CommandResult<MutationResult> {
    if entries.is_empty() {
        return Ok(MutationResult {
            ok: true,
            error: None,
            external_change_merged: false,
        });
    }
    let gate_roots: Vec<String> = entries
        .iter()
        .map(|entry| entry.project_root.clone())
        .collect();
    let gate_refs: Vec<&str> = gate_roots.iter().map(String::as_str).collect();
    team_history_mutation_via(
        &state.project_root,
        &state.project_root_identity,
        &gate_refs,
        move |target| save_batch_authorized(target, entries),
    )
    .await
}

#[tauri::command]
pub async fn team_history_delete(
    state: State<'_, AppState>,
    project_root: String,
    id: String,
) -> CommandResult<MutationResult> {
    team_history_mutation_via(
        &state.project_root,
        &state.project_root_identity,
        &[project_root.as_str()],
        move |target| delete_authorized(target, id),
    )
    .await
}

/// strict active-root gate と後続 writer の順序を固定する。writer だけを注入可能にし、
/// 実 gate 自体は差し替えられないため、拒否 request は STORE lock / disk I/O / hydration
/// へ進まない。`entry_project_roots` は mutation が影響を主張する全 project_root で、
/// (1) 相互に同一 project を指すこと (mixed batch の fail-closed)、(2) gate 時 active raw
/// snapshot key と表記まで一致すること (alias 持ち込みの fail-closed) を検証する。
pub(crate) async fn team_history_mutation_via<R, Writer, Fut>(
    project_root_slot: &ArcSwapOption<String>,
    project_root_identity_slot: &ArcSwapOption<ProjectRootIdentity>,
    entry_project_roots: &[&str],
    writer: Writer,
) -> CommandResult<R>
where
    Writer: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = R>,
{
    let Some((first, rest)) = entry_project_roots.split_first() else {
        return Err(CommandError::authz(
            "team history mutation requires a project_root",
        ));
    };
    // batch 内の混在は gate 前に I/O なしで弾く。1 entry でも別 project を指すなら全体 reject。
    let first_key = normalize_stored_project_root(first);
    if rest
        .iter()
        .any(|root| normalize_stored_project_root(root) != first_key)
    {
        return Err(CommandError::authz(
            "mixed project_root entries are not allowed in one mutation",
        ));
    }
    let authorized = crate::commands::authz::assert_active_project_root_with_raw(
        project_root_slot,
        project_root_identity_slot,
        first,
    )
    .await?;
    // gate は canonical identity で照合するが、storage は raw key で選別する (#1147)。
    // alias 表記の entry を許すと active raw の list から見えない孤児履歴が書けてしまう
    // ため、表記の一致まで要求する。
    let target = authorized.active_raw_key();
    if first_key != target {
        return Err(CommandError::authz(
            "entry project_root must match the active project root notation",
        ));
    }
    Ok(writer(target).await)
}

/// 削除は id と gate 時 active raw key の両方が一致した entry だけを対象にする。
/// foreign project の entry は id が一致しても触らない (存在有無も漏らさず no-op)。
fn remove_scoped_entry(candidate: &mut Vec<TeamHistoryEntry>, target: &str, id: &str) {
    candidate
        .retain(|e| !(e.id == id && normalize_stored_project_root(&e.project_root) == target));
}

fn has_scoped_entry(entries: &[TeamHistoryEntry], target: &str, id: &str) -> bool {
    entries
        .iter()
        .any(|e| e.id == id && normalize_stored_project_root(&e.project_root) == target)
}

async fn save_authorized(target: String, mut entry: TeamHistoryEntry) -> MutationResult {
    debug_assert_eq!(normalize_stored_project_root(&entry.project_root), target);
    // Issue #624: DoS 防御 — 1 MiB 超の entry は merge 前に reject する。
    if let Err(e) = validate_entry_size(&entry) {
        return MutationResult {
            ok: false,
            error: Some(e),
            external_change_merged: false,
        };
    }
    // Issue #1194: hydration (team_state の disk read) も gate 通過後にのみ行う。
    hydrate_orchestration_summary(&mut entry).await;
    // Issue #739: 旧 LOCK / CACHE / DISK_FINGERPRINT の 3 段ロックを STORE 1 ロックに統合。
    let mut store = STORE.lock().await;
    ensure_loaded(&mut store).await;
    let TeamHistoryStore { cache, sync_state } = &mut *store;
    let all = cache.as_mut().expect("ensured");

    // Issue #642: save 直前に disk を再 stat。手編集 / 別 vibe-editor インスタンスが
    // team-history.json を書き換えていれば fingerprint 不一致になり、disk を reload して
    // 「今回 save 対象でない id」だけを cache に取り込む。これで外部編集が in-memory cache の
    // 古い state で blind-overwrite される事故 (= stale-write) を防ぐ。
    let path = store_path();
    let mut incoming_ids = HashSet::new();
    incoming_ids.insert(entry.id.clone());
    let external_change_merged =
        reconcile_external_changes(&path, all, sync_state, &incoming_ids).await;

    // Issue #46 + #640: 新エントリは必ず残す。merge_entry で per-project MAX 件まで圧縮。
    // write-ahead — disk write 成功時だけ cache + sync_state に commit する。
    let path_for_save = path.clone();
    apply_with_disk_commit(
        all,
        sync_state,
        external_change_merged,
        |candidate| merge_entry(candidate, entry),
        |entries| async move { super::save_all(&path_for_save, &entries).await },
    )
    .await
}

async fn save_batch_authorized(
    target: String,
    entries: Vec<TeamHistoryEntry>,
) -> MutationResult {
    // Issue #624: 各 entry を merge 前に validate (1 件でも巨大なら全体 reject)。
    for entry in &entries {
        debug_assert_eq!(normalize_stored_project_root(&entry.project_root), target);
        if let Err(e) = validate_entry_size(entry) {
            return MutationResult {
                ok: false,
                error: Some(e),
                external_change_merged: false,
            };
        }
    }
    // hydrate は disk I/O を伴うので STORE ロックの外で行う (cache mutate は行わないので安全)。
    // Issue #1194: gate 通過後にのみ実行される。
    let mut hydrated: Vec<TeamHistoryEntry> = Vec::with_capacity(entries.len());
    for mut entry in entries {
        hydrate_orchestration_summary(&mut entry).await;
        hydrated.push(entry);
    }

    // Issue #739: 旧 LOCK / CACHE / DISK_FINGERPRINT の 3 段ロックを STORE 1 ロックに統合。
    let mut store = STORE.lock().await;
    ensure_loaded(&mut store).await;
    let TeamHistoryStore { cache, sync_state } = &mut *store;
    let all = cache.as_mut().expect("ensured");
    let path = store_path();

    // Issue #642: batch save の対象 id を `incoming_ids` として束ねる。reconcile が disk を
    // 読み直したとき、これら以外の id は disk 側を尊重 (= 外部編集を保持) する。
    let incoming_ids: HashSet<String> = hydrated.iter().map(|e| e.id.clone()).collect();
    let external_change_merged =
        reconcile_external_changes(&path, all, sync_state, &incoming_ids).await;

    // Issue #640: write-ahead — disk write 成功時だけ cache + sync_state に commit する。
    let path_for_save = path.clone();
    apply_with_disk_commit(
        all,
        sync_state,
        external_change_merged,
        |candidate| {
            for entry in hydrated {
                merge_entry(candidate, entry);
            }
        },
        |entries| async move { super::save_all(&path_for_save, &entries).await },
    )
    .await
}

async fn delete_authorized(target: String, id: String) -> MutationResult {
    // Issue #739: 旧 LOCK / CACHE / DISK_FINGERPRINT の 3 段ロックを STORE 1 ロックに統合。
    let mut store = STORE.lock().await;
    ensure_loaded(&mut store).await;
    let TeamHistoryStore { cache, sync_state } = &mut *store;
    let all = cache.as_mut().expect("ensured");
    let path = store_path();

    // Issue #642: delete 直前にも fingerprint をチェック。削除対象 id 自体は cache 側で
    // retain で消すため `incoming_ids` に含めて disk から押し戻されないようにする。
    let mut incoming_ids = HashSet::new();
    incoming_ids.insert(id.clone());
    let external_change_merged =
        reconcile_external_changes(&path, all, sync_state, &incoming_ids).await;

    // active project に属する該当 entry が無く、外部変更の merge も無ければ disk write 自体
    // 不要 (ok を返す)。foreign project の同名 id はここで対象外になり no-op で返る。
    // ただし外部変更を merge した場合は disk と cache の差分が変わっている可能性があるため
    // 必ず save し直して fingerprint を再同期する。
    if !has_scoped_entry(all, &target, &id) && !external_change_merged {
        return MutationResult {
            ok: true,
            error: None,
            external_change_merged,
        };
    }

    // Issue #640: write-ahead — disk write 成功時だけ cache + sync_state に commit する。
    let path_for_save = path.clone();
    apply_with_disk_commit(
        all,
        sync_state,
        external_change_merged,
        |candidate| remove_scoped_entry(candidate, &target, &id),
        |entries| async move { super::save_all(&path_for_save, &entries).await },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, project_root: &str) -> TeamHistoryEntry {
        TeamHistoryEntry {
            id: id.to_string(),
            name: format!("team-{id}"),
            project_root: project_root.to_string(),
            created_at: "2026-07-12T00:00:00Z".to_string(),
            last_used_at: "2026-07-12T00:00:00Z".to_string(),
            members: Vec::new(),
            organization: None,
            canvas_state: None,
            latest_handoff: None,
            orchestration: None,
        }
    }

    #[test]
    fn remove_scoped_entry_only_touches_active_project_rows() {
        let mut candidate = vec![
            entry("dup", "/tmp/active"),
            entry("dup", "/tmp/foreign"),
            entry("other", "/tmp/active"),
        ];
        remove_scoped_entry(&mut candidate, "/tmp/active", "dup");
        let remaining: Vec<(&str, &str)> = candidate
            .iter()
            .map(|e| (e.id.as_str(), e.project_root.as_str()))
            .collect();
        assert_eq!(
            remaining,
            vec![("dup", "/tmp/foreign"), ("other", "/tmp/active")]
        );
    }

    #[test]
    fn has_scoped_entry_ignores_foreign_project_ids() {
        let entries = vec![entry("dup", "/tmp/foreign")];
        assert!(!has_scoped_entry(&entries, "/tmp/active", "dup"));
        assert!(has_scoped_entry(&entries, "/tmp/foreign", "dup"));
    }
}

// team_history.* command — 旧 src/main/ipc/team-history.ts に対応
//
// ~/.vibe-editor/team-history.json (JSON 配列) を読み書き。
// プロジェクト単位のフィルタ、最新 20 件 + lastUsedAt 降順保持。

use crate::commands::team_state::TeamOrchestrationSummary;
use crate::pty::path_norm::normalize_project_root;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tokio::fs;
use tokio::sync::Mutex;

/// Issue #132: in-memory cache。`load_all` が毎回ディスク I/O していたのを解消する。
/// `None` は「未ロード」、`Some(...)` は「ディスクと同期済み」状態。
static CACHE: once_cell::sync::Lazy<Mutex<Option<Vec<TeamHistoryEntry>>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));

/// Issue #27: 20 件制限は project 単位で適用する。
/// ("project A で 10 件保存している状態で project B を使うと project A が消える"
/// 挙動を避けるため)
const MAX_ENTRIES_PER_PROJECT: usize = 20;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TeamHistoryMember {
    pub role: String,
    pub agent: String,
    /// Issue #470: Canvas / TeamHub の配送先 identity。旧履歴では未設定のため復元時 fallback する。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    pub session_id: Option<String>,
    /// ユーザーが手動でリネームしたタブ名 (resume 時に復元する。null なら自動生成名)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_label: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TeamCanvasNode {
    pub agent_id: String,
    pub x: f64,
    pub y: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TeamCanvasViewport {
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TeamCanvasState {
    pub nodes: Vec<TeamCanvasNode>,
    pub viewport: TeamCanvasViewport,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TeamOrganizationMeta {
    pub id: String,
    pub name: String,
    pub color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HandoffReference {
    pub id: String,
    pub kind: String,
    pub status: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    pub json_path: String,
    pub markdown_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replacement_for_agent_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TeamHistoryEntry {
    pub id: String,
    pub name: String,
    pub project_root: String,
    pub created_at: String,
    pub last_used_at: String,
    pub members: Vec<TeamHistoryMember>,
    /// Issue #370: Canvas 複数組織の表示・復元用メタデータ (optional, 後方互換)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organization: Option<TeamOrganizationMeta>,
    /// Phase 5: Canvas モードの配置状態 (optional, 後方互換)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canvas_state: Option<TeamCanvasState>,
    /// Issue #359: 最新 handoff の参照のみ。本文は handoffs store に置く。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_handoff: Option<HandoffReference>,
    /// Issue #470: TeamHub orchestration state の軽量要約。本体は team-state store に置く。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orchestration: Option<TeamOrchestrationSummary>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MutationResult {
    pub ok: bool,
    pub error: Option<String>,
}

static LOCK: once_cell::sync::Lazy<Mutex<()>> = once_cell::sync::Lazy::new(|| Mutex::new(()));

fn store_path() -> PathBuf {
    crate::util::config_paths::vibe_root().join("team-history.json")
}

/// Issue #132: cache が live なら disk I/O をスキップ。
/// 初回呼び出し時のみディスクから読む。以後 LOCK 配下で cache を直接更新する。
async fn ensure_loaded(cache: &mut Option<Vec<TeamHistoryEntry>>) {
    if cache.is_some() {
        return;
    }
    let path = store_path();
    let Ok(bytes) = fs::read(&path).await else {
        *cache = Some(Vec::new());
        return;
    };
    let entries = serde_json::from_slice::<Vec<TeamHistoryEntry>>(&bytes).unwrap_or_default();
    *cache = Some(entries);
}

async fn save_all(entries: &[TeamHistoryEntry]) -> crate::commands::error::CommandResult<()> {
    let path = store_path();
    let json = serde_json::to_vec_pretty(entries).map_err(|e| e.to_string())?;
    // Issue #37: クラッシュ耐性のため atomic write を使う
    // Issue #608 (Security): team-history.json は project_root / agent_id / session_id を
    // 含み、外部から読まれると過去の作業範囲を推定されうるため 0o600 で永続化。
    Ok(
        crate::commands::atomic_write::atomic_write_with_mode(&path, &json, Some(0o600))
            .await
            .map_err(|e| e.to_string())?,
    )
}

/// Issue #640: write-ahead pattern。disk write が成功した後だけ cache に commit する。
///
/// 旧実装は `cache を mutate → save_all` の順で動いていたため、disk write が失敗 (ENOSPC /
/// 読み取り専用ファイル / 権限不足等) すると cache だけが新しい状態のまま残り、renderer 側に
/// IPC エラーを返しても cache は新規 entry を保持したまま、再起動で disk から旧 state が
/// load された瞬間に「保存できなかったはずの entry が消える」UX バグが起きていた。
///
/// `apply_with_disk_commit` は write-ahead に変更:
/// 1. `mutate` を cache の clone に対して適用 → 候補 state を作る
/// 2. `save_fn` で候補 state を disk に書く
/// 3. write 成功なら cache に candidate を commit、失敗なら cache はそのまま
///
/// テスト容易性のため `save_fn` を引数に取り、失敗 mock を差し込めるようにしている。
async fn apply_with_disk_commit<F, Fut>(
    cache: &mut Vec<TeamHistoryEntry>,
    mutate: impl FnOnce(&mut Vec<TeamHistoryEntry>),
    save_fn: F,
) -> MutationResult
where
    F: FnOnce(Vec<TeamHistoryEntry>) -> Fut,
    Fut: std::future::Future<Output = crate::commands::error::CommandResult<()>>,
{
    // 1. cache を clone した上で mutate (cache 本体はまだ触らない)
    let mut candidate: Vec<TeamHistoryEntry> = cache.clone();
    mutate(&mut candidate);

    // 2. disk 書き込み — 失敗したら cache は旧 state のまま (rollback 不要)
    match save_fn(candidate.clone()).await {
        Ok(_) => {
            // 3. 成功した場合のみ cache に commit
            *cache = candidate;
            MutationResult {
                ok: true,
                error: None,
            }
        }
        Err(e) => MutationResult {
            ok: false,
            error: Some(e.to_string()),
        },
    }
}

#[tauri::command]
pub async fn team_history_list(project_root: String) -> Vec<TeamHistoryEntry> {
    let _g = LOCK.lock().await;
    let mut cache = CACHE.lock().await;
    ensure_loaded(&mut cache).await;
    // Issue #32: 比較は normalize 後の値で行う
    let target = normalize_project_root(&project_root);
    cache
        .as_ref()
        .map(|all| {
            all.iter()
                .filter(|e| normalize_project_root(&e.project_root) == target)
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

/// Issue #132 共通ヘルパ: 1 つの新エントリを cache に merge して MAX 件まで圧縮する。
fn merge_entry(all: &mut Vec<TeamHistoryEntry>, entry: TeamHistoryEntry) {
    all.retain(|e| e.id != entry.id);
    let new_entry_key = normalize_project_root(&entry.project_root);
    all.sort_by(|a, b| b.last_used_at.cmp(&a.last_used_at));
    let mut kept: Vec<TeamHistoryEntry> = Vec::with_capacity(all.len() + 1);
    kept.push(entry);
    let mut per_project_count: HashMap<String, usize> = HashMap::new();
    per_project_count.insert(new_entry_key, 1);
    for e in std::mem::take(all).into_iter() {
        let key = normalize_project_root(&e.project_root);
        let count = per_project_count.entry(key).or_insert(0);
        if *count < MAX_ENTRIES_PER_PROJECT {
            *count += 1;
            kept.push(e);
        }
    }
    kept.sort_by(|a, b| b.last_used_at.cmp(&a.last_used_at));
    *all = kept;
}

async fn hydrate_orchestration_summary(entry: &mut TeamHistoryEntry) {
    if let Some(summary) =
        crate::commands::team_state::orchestration_summary(&entry.project_root, &entry.id).await
    {
        entry.orchestration = Some(summary);
    }
}

#[tauri::command]
pub async fn team_history_save(mut entry: TeamHistoryEntry) -> MutationResult {
    hydrate_orchestration_summary(&mut entry).await;
    let _g = LOCK.lock().await;
    let mut cache = CACHE.lock().await;
    ensure_loaded(&mut cache).await;
    let all = cache.as_mut().expect("ensured");

    // Issue #46: 新エントリは必ず残す。merge_entry で per-project MAX 件まで圧縮。
    // Issue #640: write-ahead — disk write 成功時だけ cache に commit する。
    apply_with_disk_commit(
        all,
        |candidate| merge_entry(candidate, entry),
        |entries| async move { save_all(&entries).await },
    )
    .await
}

/// Issue #132: 複数チームの保存を 1 IPC + 1 disk write にまとめる。
/// CanvasLayout の auto-save が N チーム分 N 回保存していたのを 1 回にする。
#[tauri::command]
pub async fn team_history_save_batch(entries: Vec<TeamHistoryEntry>) -> MutationResult {
    if entries.is_empty() {
        return MutationResult {
            ok: true,
            error: None,
        };
    }
    // hydrate は disk I/O を伴うので LOCK の外で行う (cache mutate は行わないので安全)
    let mut hydrated: Vec<TeamHistoryEntry> = Vec::with_capacity(entries.len());
    for mut entry in entries {
        hydrate_orchestration_summary(&mut entry).await;
        hydrated.push(entry);
    }

    let _g = LOCK.lock().await;
    let mut cache = CACHE.lock().await;
    ensure_loaded(&mut cache).await;
    let all = cache.as_mut().expect("ensured");

    // Issue #640: write-ahead — disk write 成功時だけ cache に commit する。
    apply_with_disk_commit(
        all,
        |candidate| {
            for entry in hydrated {
                merge_entry(candidate, entry);
            }
        },
        |entries| async move { save_all(&entries).await },
    )
    .await
}

#[tauri::command]
pub async fn team_history_delete(id: String) -> MutationResult {
    let _g = LOCK.lock().await;
    let mut cache = CACHE.lock().await;
    ensure_loaded(&mut cache).await;
    let all = cache.as_mut().expect("ensured");
    // 該当 entry が無ければ disk write 自体不要 (ok を返す)
    if !all.iter().any(|e| e.id == id) {
        return MutationResult {
            ok: true,
            error: None,
        };
    }

    // Issue #640: write-ahead — disk write 成功時だけ cache に commit する。
    apply_with_disk_commit(
        all,
        |candidate| candidate.retain(|e| e.id != id),
        |entries| async move { save_all(&entries).await },
    )
    .await
}

#[cfg(test)]
mod tests {
    //! Issue #640: write-ahead pattern (`apply_with_disk_commit`) の振る舞いを検証する。
    //!
    //! 旧実装は cache を mutate してから disk write していたため、disk write 失敗時に
    //! cache が新規 state のまま残り、renderer 側に IPC エラーを返しても再起動で消える
    //! データ不整合が起きていた。新実装は write-ahead 化しているので、failure path で
    //! cache が old state のまま保持されることを下記で担保する。
    use super::*;

    fn make_entry(id: &str, project: &str, last_used_at: &str) -> TeamHistoryEntry {
        TeamHistoryEntry {
            id: id.to_string(),
            name: format!("team-{}", id),
            project_root: project.to_string(),
            created_at: last_used_at.to_string(),
            last_used_at: last_used_at.to_string(),
            members: Vec::new(),
            organization: None,
            canvas_state: None,
            latest_handoff: None,
            orchestration: None,
        }
    }

    /// Issue #640 root cause: 旧実装は cache を mutate してから disk write していたので
    /// failure path で「renderer に Err を返したのに cache だけ更新済み」状態が残った。
    /// 新実装は disk write 失敗時 cache が touch されないことを検証する。
    #[tokio::test]
    async fn apply_with_disk_commit_does_not_mutate_cache_on_save_failure() {
        use crate::commands::error::CommandError;
        let mut cache = vec![make_entry("a", "/proj/x", "2026-05-09T00:00:00Z")];
        let snapshot_before = cache.clone();

        let result = apply_with_disk_commit(
            &mut cache,
            |candidate| {
                merge_entry(
                    candidate,
                    make_entry("b", "/proj/x", "2026-05-10T00:00:00Z"),
                );
            },
            |_entries| async { Err(CommandError::Io("disk full".to_string())) },
        )
        .await;

        // IPC は失敗を返す
        assert!(!result.ok);
        assert_eq!(result.error.as_deref(), Some("disk full"));
        // cache は old state のまま (新 entry "b" は入っていない)
        assert_eq!(cache.len(), snapshot_before.len());
        assert_eq!(cache[0].id, "a");
        assert!(cache.iter().all(|e| e.id != "b"));
    }

    /// 成功 path では cache に candidate が commit される。
    #[tokio::test]
    async fn apply_with_disk_commit_commits_cache_on_save_success() {
        let mut cache = vec![make_entry("a", "/proj/x", "2026-05-09T00:00:00Z")];

        let result = apply_with_disk_commit(
            &mut cache,
            |candidate| {
                merge_entry(
                    candidate,
                    make_entry("b", "/proj/x", "2026-05-10T00:00:00Z"),
                );
            },
            |_entries| async { Ok(()) },
        )
        .await;

        assert!(result.ok);
        assert!(result.error.is_none());
        // cache に新 entry が反映されている
        assert_eq!(cache.len(), 2);
        assert!(cache.iter().any(|e| e.id == "b"));
        assert!(cache.iter().any(|e| e.id == "a"));
    }

    /// delete 経路の write-ahead: disk write 失敗時に cache から entry が消えていないこと。
    #[tokio::test]
    async fn apply_with_disk_commit_delete_path_rolls_back_on_failure() {
        use crate::commands::error::CommandError;
        let mut cache = vec![
            make_entry("a", "/proj/x", "2026-05-09T00:00:00Z"),
            make_entry("b", "/proj/x", "2026-05-10T00:00:00Z"),
        ];

        let target_id = "a".to_string();
        let result = apply_with_disk_commit(
            &mut cache,
            |candidate| candidate.retain(|e| e.id != target_id),
            |_entries| async { Err(CommandError::Io("permission denied".to_string())) },
        )
        .await;

        assert!(!result.ok);
        // "a" がまだ cache に残っている (renderer に IPC Err を返したのに消えた、を防ぐ)
        assert_eq!(cache.len(), 2);
        assert!(cache.iter().any(|e| e.id == "a"));
    }

    /// batch save 経路: 複数 entry を 1 候補に重ねた後、disk 失敗で全部 rollback される。
    #[tokio::test]
    async fn apply_with_disk_commit_batch_save_rolls_back_all_on_failure() {
        use crate::commands::error::CommandError;
        let mut cache = vec![make_entry("a", "/proj/x", "2026-05-09T00:00:00Z")];
        let new_entries = vec![
            make_entry("b", "/proj/x", "2026-05-10T00:00:00Z"),
            make_entry("c", "/proj/x", "2026-05-10T01:00:00Z"),
        ];

        let result = apply_with_disk_commit(
            &mut cache,
            |candidate| {
                for entry in new_entries {
                    merge_entry(candidate, entry);
                }
            },
            |_entries| async { Err(CommandError::Io("io error".to_string())) },
        )
        .await;

        assert!(!result.ok);
        // batch 全件 rollback (b, c は cache に存在しない)
        assert_eq!(cache.len(), 1);
        assert_eq!(cache[0].id, "a");
        assert!(cache.iter().all(|e| e.id != "b" && e.id != "c"));
    }

    /// save_fn に渡される候補 state は mutate 適用済みであることを検証
    /// (renderer に書き出される正しい state が disk へ流れていく)。
    #[tokio::test]
    async fn apply_with_disk_commit_passes_candidate_state_to_save_fn() {
        let mut cache = vec![make_entry("a", "/proj/x", "2026-05-09T00:00:00Z")];
        let captured: std::sync::Arc<std::sync::Mutex<Option<Vec<String>>>> =
            std::sync::Arc::new(std::sync::Mutex::new(None));
        let captured_for_fn = captured.clone();

        let result = apply_with_disk_commit(
            &mut cache,
            |candidate| {
                merge_entry(
                    candidate,
                    make_entry("b", "/proj/x", "2026-05-10T00:00:00Z"),
                );
            },
            |entries| {
                let captured_for_fn = captured_for_fn.clone();
                async move {
                    let ids: Vec<String> = entries.iter().map(|e| e.id.clone()).collect();
                    *captured_for_fn.lock().unwrap() = Some(ids);
                    Ok(())
                }
            },
        )
        .await;

        assert!(result.ok);
        let saved = captured.lock().unwrap().clone().expect("save_fn was called");
        // disk へ書き出された候補は mutate 適用後 (a, b の両方を含む)
        assert_eq!(saved.len(), 2);
        assert!(saved.iter().any(|id| id == "a"));
        assert!(saved.iter().any(|id| id == "b"));
    }
}

// team_history.* command — 旧 src/main/ipc/team-history.ts に対応
//
// ~/.vibe-editor/team-history.json (JSON 配列) を読み書き。
// プロジェクト単位のフィルタ、最新 20 件 + lastUsedAt 降順保持。

use crate::commands::files::hash::{mtime_ms_of, sha256_hex};
use crate::commands::team_state::TeamOrchestrationSummary;
use crate::pty::path_norm::normalize_project_root;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tokio::fs;
use tokio::sync::Mutex;

/// Issue #642 / #739: cache を最後に disk と同期したときの状態を表す sum type。
///
/// 旧実装は `Option<Option<DiskFingerprint>>` という二重 Option で同じ三状態を表していたが、
/// 「外側 `None` と内側 `None` のどちらが何を意味するか」がコードを読まないと分からなかった。
/// 三状態を enum で明示することで、`ensure_loaded` の「ロード済みか」判定と
/// `reconcile_external_changes` の「同期済み fingerprint」取得が意図どおり読めるようにする。
#[derive(Clone, Debug, PartialEq, Eq, Default)]
enum DiskSyncState {
    /// fingerprint 未取得 (= cache も未ロードの初期状態)。旧 `Outer None` に対応。
    #[default]
    Unknown,
    /// disk 上に `team-history.json` が存在しない状態を確認済み。旧 `Outer Some(None)` に対応。
    Absent,
    /// `fp` の disk と同期済み。旧 `Outer Some(Some(fp))` に対応。
    Synced(DiskFingerprint),
}

impl DiskSyncState {
    /// `ensure_loaded` 用: 既に disk 状態を確認済み (= cache をロード済み) かどうか。
    fn is_known(&self) -> bool {
        !matches!(self, DiskSyncState::Unknown)
    }

    /// `reconcile_external_changes` 用: 最後に同期した fingerprint。
    /// `Unknown` / `Absent` はいずれも「ファイルが無い / 未取得」なので `None` を返す
    /// (= 旧 `Option<Option<DiskFingerprint>>::and_then(|f| f.clone())` と同じ畳み込み)。
    fn synced_fingerprint(&self) -> Option<DiskFingerprint> {
        match self {
            DiskSyncState::Synced(fp) => Some(fp.clone()),
            _ => None,
        }
    }
}

/// Issue #739: 旧 `LOCK` / `CACHE` / `DISK_FINGERPRINT` の 3 つの Mutex を 1 つに統合した
/// グローバル state。各 command が「LOCK → CACHE → DISK_FINGERPRINT」を 3 段ロックしていた
/// (= 4 command で同じパターンが 4 回) のを `STORE` 1 ロックに置き換える。
///
/// - `cache`: Issue #132 の in-memory cache。`None` は「未ロード」、`Some(...)` は
///   「ディスクと同期済み」状態 (旧 `CACHE` と同じセマンティクス)。
/// - `sync_state`: Issue #642 の disk fingerprint 三状態 (旧 `DISK_FINGERPRINT`)。
///
/// `cache` と `sync_state` を同一 Mutex 配下に置くことで、両者が原子的に整合した状態でしか
/// 観測されないことが型レベルで保証される (旧実装は別 Mutex だったため理論上の skew があった)。
#[derive(Default)]
struct TeamHistoryStore {
    cache: Option<Vec<TeamHistoryEntry>>,
    sync_state: DiskSyncState,
}

static STORE: once_cell::sync::Lazy<Mutex<TeamHistoryStore>> =
    once_cell::sync::Lazy::new(|| Mutex::new(TeamHistoryStore::default()));

/// disk 上の `team-history.json` の状態を一意に識別するフィンガープリント。
/// Issue #119 と同じく `mtime + size + sha256` の三要素で「秒精度しかない FS で同サイズに
/// 上書きされた」ケースまで取りこぼさない。`hash` を保持しておくことで、save の直前に
/// disk の hash を再計算するだけで「外部変更が起きたか」を確実に判定できる。
#[derive(Clone, Debug, PartialEq, Eq)]
struct DiskFingerprint {
    mtime_ms: Option<u64>,
    size: u64,
    hash: String,
}

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Issue #642: 保存直前に disk 上の `team-history.json` が外部 (手編集 / 別プロセス) で
    /// 書き換わっていることを検知し、disk 側の独自エントリを取り込んで merge してから
    /// 書き戻したかどうか。renderer 側はこのフラグが true のとき toast / list 再取得を
    /// 行うことでユーザーに「外部変更を取り込んだ」事実を伝えられる。
    /// 既存 caller との互換のため `false` のときは JSON に出さない。
    #[serde(default, skip_serializing_if = "is_false")]
    pub external_change_merged: bool,
}

#[inline]
fn is_false(v: &bool) -> bool {
    !*v
}

fn store_path() -> PathBuf {
    crate::util::config_paths::vibe_root().join("team-history.json")
}

/// Issue #132: cache が live なら disk I/O をスキップ。
/// 初回呼び出し時のみディスクから読む。以後 STORE ロック配下で cache を直接更新する。
///
/// Issue #642: cache を seed するのと同時に `sync_state` も同 disk 状態で初期化する。
/// `DiskSyncState::Absent` は「disk 上にファイルなしを確認済み」、`DiskSyncState::Synced(fp)`
/// は「fp の disk と同期済み」を表す。以後の save 系で fingerprint を比較し、外部変更を検知する。
async fn ensure_loaded(store: &mut TeamHistoryStore) {
    // Issue #739: 旧 `cache.is_some() && fingerprint.is_some()` と等価。
    // `sync_state.is_known()` (= Absent / Synced) は旧 `fingerprint.is_some()` と一致する。
    if store.cache.is_some() && store.sync_state.is_known() {
        return;
    }
    let path = store_path();
    match fs::read(&path).await {
        Ok(bytes) => {
            let entries =
                serde_json::from_slice::<Vec<TeamHistoryEntry>>(&bytes).unwrap_or_default();
            store.cache = Some(entries);
            // Issue #642: 起動直後の fingerprint を保存。以後の save 直前にこれと現在 disk の
            // fingerprint を比較して「外部変更が起きたか」を判定する。
            let meta = fs::metadata(&path).await.ok();
            let mtime_ms = meta.as_ref().and_then(mtime_ms_of);
            let size = meta.as_ref().map(|m| m.len()).unwrap_or(bytes.len() as u64);
            store.sync_state = DiskSyncState::Synced(DiskFingerprint {
                mtime_ms,
                size,
                hash: sha256_hex(&bytes),
            });
        }
        Err(_) => {
            store.cache = Some(Vec::new());
            // ファイルが存在しない状態を確認済みとして記録する。
            store.sync_state = DiskSyncState::Absent;
        }
    }
}

/// Issue #642: 現在 disk 上の fingerprint を計算する。ファイルが読めない / 存在しない場合は
/// `None` を返す。`compute_fingerprint(path).await == fingerprint_at_last_sync` であれば
/// 「外部変更なし」を意味する。
async fn compute_fingerprint(path: &Path) -> Option<DiskFingerprint> {
    let bytes = fs::read(path).await.ok()?;
    let meta = fs::metadata(path).await.ok();
    let mtime_ms = meta.as_ref().and_then(mtime_ms_of);
    let size = meta.as_ref().map(|m| m.len()).unwrap_or(bytes.len() as u64);
    Some(DiskFingerprint {
        mtime_ms,
        size,
        hash: sha256_hex(&bytes),
    })
}

/// Issue #642: disk 上の `team-history.json` を読み直して現状の entries と fingerprint を返す。
/// fingerprint 不一致時の reload で使う。
async fn reload_disk_entries(path: &Path) -> (Vec<TeamHistoryEntry>, Option<DiskFingerprint>) {
    let Ok(bytes) = fs::read(path).await else {
        return (Vec::new(), None);
    };
    let entries = serde_json::from_slice::<Vec<TeamHistoryEntry>>(&bytes).unwrap_or_default();
    let meta = fs::metadata(path).await.ok();
    let mtime_ms = meta.as_ref().and_then(mtime_ms_of);
    let size = meta.as_ref().map(|m| m.len()).unwrap_or(bytes.len() as u64);
    let fp = DiskFingerprint {
        mtime_ms,
        size,
        hash: sha256_hex(&bytes),
    };
    (entries, Some(fp))
}

/// Issue #642: disk 側で先行している (= 外部編集された) entries を cache に取り込む。
///
/// `incoming_ids` は「この save 呼び出しで cache 側が authoritative にしたい id 集合」。
/// それ以外の id は disk 側を採用する (= ユーザーの手編集を保持)。
///
/// merge ルール (fingerprint 不一致時のみ呼ばれる前提なので「disk は何か変わった」が確定):
/// - `incoming_ids` に含まれる id → cache 側 (in-process 変更) を最優先で保持。
///   disk から押し戻されない (= 今回の save が無効化されない)。
/// - disk のみに存在する id → disk から取り込み (外部追加)。
/// - 両方に存在し `incoming_ids` に含まれない id → disk 側を採用 (外部編集を尊重)。
///   `summary` だけ書き換えるような `last_used_at` 不変の手編集も拾える。
/// - cache のみに存在し `incoming_ids` に含まれない id → 外部で削除された可能性が高いが、
///   in-process が握っている state を勝手に消すのは事故が大きいので残す
///   (= disk と次回 save 時にもう一度突き合わせる)。
fn merge_external_disk(
    cache: &mut Vec<TeamHistoryEntry>,
    disk: Vec<TeamHistoryEntry>,
    incoming_ids: &HashSet<String>,
) -> bool {
    let mut by_id: HashMap<String, TeamHistoryEntry> = HashMap::new();
    for entry in cache.drain(..) {
        by_id.insert(entry.id.clone(), entry);
    }
    let mut external_change_merged = false;
    for d_entry in disk {
        if incoming_ids.contains(&d_entry.id) {
            // 今回の save 対象 → cache 側を優先 (= 何もしない)。
            continue;
        }
        match by_id.get(&d_entry.id) {
            None => {
                // cache に存在しない id → 外部で追加された entry。取り込む。
                external_change_merged = true;
                by_id.insert(d_entry.id.clone(), d_entry);
            }
            Some(c_entry) => {
                // 内容が同一なら何もしない。差分があれば disk を採用 (= 外部編集を保持)。
                // serde_json で比較すると float 等を含めても安全だが、ここでは生の Vec/Option/
                // String のみで `clone + serde_json::to_value` の余計なコストを避けるため、
                // 必要に応じて serde_json::to_value で比較する。
                if !same_entry(c_entry, &d_entry) {
                    external_change_merged = true;
                    by_id.insert(d_entry.id.clone(), d_entry);
                }
            }
        }
    }
    let mut merged: Vec<TeamHistoryEntry> = by_id.into_values().collect();
    merged.sort_by(|a, b| b.last_used_at.cmp(&a.last_used_at));
    *cache = merged;
    external_change_merged
}

/// 2 つの entry が同じか判定。serde_json::to_value で比較することで構造的同値を判定する
/// (Option<Vec<...>> 等の入れ子も再帰的に比較される)。
fn same_entry(a: &TeamHistoryEntry, b: &TeamHistoryEntry) -> bool {
    match (serde_json::to_value(a), serde_json::to_value(b)) {
        (Ok(va), Ok(vb)) => va == vb,
        // serde 化に失敗した場合は安全側に倒して「異なる」とし、disk 側を採用する。
        _ => false,
    }
}

/// Issue #642: save 直前の外部変更検出フロー。fingerprint 不一致なら disk を reload して
/// `incoming_ids` 以外の entry を cache 側に merge する。caller 側は merge 後の cache を
/// そのまま `save_all` に流せばよい。
///
/// 戻り値 = 「外部変更を検知して merge を行ったか」。`false` の場合は cache が disk と同期した
/// ままなので追加処理は不要。`true` の場合は renderer に通知する用の MutationResult.external_change_merged
/// に立てる。
async fn reconcile_external_changes(
    path: &Path,
    cache: &mut Vec<TeamHistoryEntry>,
    sync_state: &mut DiskSyncState,
    incoming_ids: &HashSet<String>,
) -> bool {
    let current_disk = compute_fingerprint(path).await;
    // Issue #739: 旧 `fingerprint.as_ref().and_then(|f| f.clone())` と等価。
    // `Unknown` / `Absent` はいずれも `None` に畳まれる。
    let last_synced = sync_state.synced_fingerprint();
    if current_disk == last_synced {
        return false;
    }
    // 外部変更検知: disk reload + merge
    let (disk_entries, fp) = reload_disk_entries(path).await;
    let merged = merge_external_disk(cache, disk_entries, incoming_ids);
    // `fp` が `None` (= reload 時に disk 不在) なら `Absent`、`Some(fp)` なら `Synced(fp)`。
    // 旧実装の `*fingerprint = Some(fp)` (= `Some(None)` / `Some(Some(fp))`) と一致する。
    *sync_state = match fp {
        Some(fp) => DiskSyncState::Synced(fp),
        None => DiskSyncState::Absent,
    };
    merged
}

async fn save_all(
    path: &Path,
    entries: &[TeamHistoryEntry],
) -> crate::commands::error::CommandResult<DiskFingerprint> {
    let json = serde_json::to_vec_pretty(entries).map_err(|e| e.to_string())?;
    // Issue #37: クラッシュ耐性のため atomic write を使う
    // Issue #608 (Security): team-history.json は project_root / agent_id / session_id を
    // 含み、外部から読まれると過去の作業範囲を推定されうるため 0o600 で永続化。
    crate::commands::atomic_write::atomic_write_with_mode(path, &json, Some(0o600))
        .await
        .map_err(|e| e.to_string())?;
    // Issue #642: 書き込み直後の fingerprint を計算して呼び出し側に返す。caller は
    // `STORE.sync_state` を更新することで「次回 save 時の比較基準」を最新に保つ。
    let meta = fs::metadata(path).await.ok();
    let mtime_ms = meta.as_ref().and_then(mtime_ms_of);
    let size = meta.as_ref().map(|m| m.len()).unwrap_or(json.len() as u64);
    Ok(DiskFingerprint {
        mtime_ms,
        size,
        hash: sha256_hex(&json),
    })
}

/// Issue #640 + #642: write-ahead pattern。disk write が成功した後だけ cache と fingerprint に
/// commit する。
///
/// 旧実装は `cache を mutate → save_all` の順で動いていたため、disk write が失敗 (ENOSPC /
/// 読み取り専用ファイル / 権限不足等) すると cache だけが新しい状態のまま残り、renderer 側に
/// IPC エラーを返しても cache は新規 entry を保持したまま、再起動で disk から旧 state が
/// load された瞬間に「保存できなかったはずの entry が消える」UX バグが起きていた。
///
/// `apply_with_disk_commit` は write-ahead に変更:
/// 1. `mutate` を cache の clone に対して適用 → 候補 state を作る
/// 2. `save_fn` で候補 state を disk に書く (成功時は `DiskFingerprint` を返す)
/// 3. write 成功なら cache に candidate を commit + fingerprint を更新、
///    失敗なら cache / fingerprint はそのまま
///
/// `external_change_merged` は #642 の reconcile が立てたフラグをそのまま返値に乗せて
/// renderer まで伝える。`sync_state` を `&mut` で受け取るのは success path で
/// disk と同期した最新 fingerprint を caller の `STORE.sync_state` に書き戻すため。
///
/// テスト容易性のため `save_fn` を引数に取り、失敗 mock を差し込めるようにしている。
async fn apply_with_disk_commit<F, Fut>(
    cache: &mut Vec<TeamHistoryEntry>,
    sync_state: &mut DiskSyncState,
    external_change_merged: bool,
    mutate: impl FnOnce(&mut Vec<TeamHistoryEntry>),
    save_fn: F,
) -> MutationResult
where
    F: FnOnce(Vec<TeamHistoryEntry>) -> Fut,
    Fut: std::future::Future<Output = crate::commands::error::CommandResult<DiskFingerprint>>,
{
    // 1. cache を clone した上で mutate (cache 本体はまだ触らない)
    let mut candidate: Vec<TeamHistoryEntry> = cache.clone();
    mutate(&mut candidate);

    // 2. disk 書き込み — 失敗したら cache は旧 state のまま (rollback 不要)
    match save_fn(candidate.clone()).await {
        Ok(new_fp) => {
            // 3. 成功した場合のみ cache + sync_state に commit
            *cache = candidate;
            *sync_state = DiskSyncState::Synced(new_fp);
            MutationResult {
                ok: true,
                error: None,
                external_change_merged,
            }
        }
        Err(e) => MutationResult {
            ok: false,
            error: Some(e.to_string()),
            external_change_merged,
        },
    }
}

#[tauri::command]
pub async fn team_history_list(project_root: String) -> Vec<TeamHistoryEntry> {
    // Issue #739: 旧 LOCK / CACHE / DISK_FINGERPRINT の 3 段ロックを STORE 1 ロックに統合。
    let mut store = STORE.lock().await;
    ensure_loaded(&mut store).await;
    // Issue #642: list でも fingerprint を見て外部変更があれば disk を再読込。renderer が
    // ユーザー手編集後に list を再取得したときに古い in-memory cache を返さないようにする。
    // list には書き込み対象 id が無いため `incoming_ids` は空集合 (= 全 entry を disk 側で
    // 上書き可能) として扱う。
    let path = store_path();
    let TeamHistoryStore { cache, sync_state } = &mut *store;
    let all = cache.as_mut().expect("ensured");
    let _ = reconcile_external_changes(&path, all, sync_state, &HashSet::new()).await;
    // Issue #32: 比較は normalize 後の値で行う
    let target = normalize_project_root(&project_root);
    all.iter()
        .filter(|e| normalize_project_root(&e.project_root) == target)
        .cloned()
        .collect()
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

/// Issue #624 (Security): 単一 entry の serialized size 上限。1 MiB を超える entry は
/// `team_history_save` / `team_history_save_batch` で reject し、renderer から悪意ある巨大
/// JSON で disk full まで埋める DoS 経路を塞ぐ。`team-history.json` 全体ではなく entry 単位で
/// 弾くことで、merge_entry 後の per-project cap (`#46`) と二段防御になる。
fn validate_entry_size(entry: &TeamHistoryEntry) -> Result<(), String> {
    let bytes = match serde_json::to_vec(entry) {
        Ok(b) => b,
        Err(e) => return Err(format!("entry not serializable: {e}")),
    };
    crate::commands::validation::assert_max_size(
        bytes.len(),
        crate::commands::validation::MAX_PERSIST_PAYLOAD,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn team_history_save(mut entry: TeamHistoryEntry) -> MutationResult {
    // Issue #624: DoS 防御 — 1 MiB 超の entry は merge 前に reject する。
    if let Err(e) = validate_entry_size(&entry) {
        return MutationResult {
            ok: false,
            error: Some(e),
            external_change_merged: false,
        };
    }
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
        |entries| async move { save_all(&path_for_save, &entries).await },
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
            external_change_merged: false,
        };
    }
    // Issue #624: 各 entry を merge 前に validate (1 件でも巨大なら全体 reject)。
    for entry in &entries {
        if let Err(e) = validate_entry_size(entry) {
            return MutationResult {
                ok: false,
                error: Some(e),
                external_change_merged: false,
            };
        }
    }
    // hydrate は disk I/O を伴うので STORE ロックの外で行う (cache mutate は行わないので安全)
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
        |entries| async move { save_all(&path_for_save, &entries).await },
    )
    .await
}

#[tauri::command]
pub async fn team_history_delete(id: String) -> MutationResult {
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

    // 該当 entry が無く、外部変更の merge も無ければ disk write 自体不要 (ok を返す)。
    // ただし外部変更を merge した場合は disk と cache の差分が変わっている可能性があるため
    // 必ず save し直して fingerprint を再同期する。
    if !all.iter().any(|e| e.id == id) && !external_change_merged {
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
        |candidate| candidate.retain(|e| e.id != id),
        |entries| async move { save_all(&path_for_save, &entries).await },
    )
    .await
}

#[cfg(test)]
mod tests {
    //! Issue #640 + #642: write-ahead pattern (`apply_with_disk_commit`) と外部変更検出 +
    //! merge ロジックの両方を検証する。
    //!
    //! - #640: 旧実装は cache を mutate してから disk write していたため、disk write 失敗時に
    //!   cache が新規 state のまま残り、renderer 側に IPC エラーを返しても再起動で消える
    //!   データ不整合が起きていた。新実装は write-ahead 化しているので、failure path で
    //!   cache が old state のまま保持されることを下記で担保する。
    //! - #642: `team_history_save` 等の Tauri command 自体は `~/.vibe-editor/team-history.json`
    //!   を直接読み書きするので、ここでは `compute_fingerprint` / `reload_disk_entries` /
    //!   `save_all` を tempdir 配下のパスに対して直接呼ぶ + `merge_external_disk` の merge
    //!   セマンティクス + `reconcile_external_changes` の fingerprint 不一致時の挙動を unit
    //!   test で cover する。
    use super::*;
    use tempfile::tempdir;

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

    fn entry(id: &str, summary: &str, last_used_at: &str) -> TeamHistoryEntry {
        let mut e = TeamHistoryEntry {
            id: id.to_string(),
            name: format!("team-{id}"),
            project_root: "/tmp/proj".to_string(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            last_used_at: last_used_at.to_string(),
            members: vec![],
            organization: None,
            canvas_state: None,
            latest_handoff: None,
            orchestration: None,
        };
        // summary 相当は orchestration.blocked_reason に詰めて差分を作る。
        if !summary.is_empty() {
            e.orchestration = Some(TeamOrchestrationSummary {
                state_path: format!("/tmp/{}.json", id),
                blocked_reason: Some(summary.to_string()),
                updated_at: last_used_at.to_string(),
                ..Default::default()
            });
        }
        e
    }

    /// Issue #640 root cause: 旧実装は cache を mutate してから disk write していたので
    /// failure path で「renderer に Err を返したのに cache だけ更新済み」状態が残った。
    /// 新実装は disk write 失敗時 cache が touch されないことを検証する。
    #[tokio::test]
    async fn apply_with_disk_commit_does_not_mutate_cache_on_save_failure() {
        use crate::commands::error::CommandError;
        let mut cache = vec![make_entry("a", "/proj/x", "2026-05-09T00:00:00Z")];
        let mut sync_state = DiskSyncState::Absent;
        let snapshot_before = cache.clone();

        let result = apply_with_disk_commit(
            &mut cache,
            &mut sync_state,
            false,
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
        // sync_state も touch されていない (Absent のまま)
        assert_eq!(sync_state, DiskSyncState::Absent);
    }

    /// 成功 path では cache に candidate が commit される + fingerprint が更新される。
    #[tokio::test]
    async fn apply_with_disk_commit_commits_cache_on_save_success() {
        let mut cache = vec![make_entry("a", "/proj/x", "2026-05-09T00:00:00Z")];
        let mut sync_state = DiskSyncState::Absent;

        let result = apply_with_disk_commit(
            &mut cache,
            &mut sync_state,
            false,
            |candidate| {
                merge_entry(
                    candidate,
                    make_entry("b", "/proj/x", "2026-05-10T00:00:00Z"),
                );
            },
            |_entries| async {
                Ok(DiskFingerprint {
                    mtime_ms: Some(1234),
                    size: 42,
                    hash: "deadbeef".to_string(),
                })
            },
        )
        .await;

        assert!(result.ok);
        assert!(result.error.is_none());
        // cache に新 entry が反映されている
        assert_eq!(cache.len(), 2);
        assert!(cache.iter().any(|e| e.id == "b"));
        assert!(cache.iter().any(|e| e.id == "a"));
        // sync_state も Synced(fp) に更新されている
        let fp = sync_state
            .synced_fingerprint()
            .expect("sync_state must be Synced after success");
        assert_eq!(fp.size, 42);
        assert_eq!(fp.hash, "deadbeef");
    }

    /// delete 経路の write-ahead: disk write 失敗時に cache から entry が消えていないこと。
    #[tokio::test]
    async fn apply_with_disk_commit_delete_path_rolls_back_on_failure() {
        use crate::commands::error::CommandError;
        let mut cache = vec![
            make_entry("a", "/proj/x", "2026-05-09T00:00:00Z"),
            make_entry("b", "/proj/x", "2026-05-10T00:00:00Z"),
        ];
        let mut sync_state = DiskSyncState::Absent;

        let target_id = "a".to_string();
        let result = apply_with_disk_commit(
            &mut cache,
            &mut sync_state,
            false,
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
        let mut sync_state = DiskSyncState::Absent;
        let new_entries = vec![
            make_entry("b", "/proj/x", "2026-05-10T00:00:00Z"),
            make_entry("c", "/proj/x", "2026-05-10T01:00:00Z"),
        ];

        let result = apply_with_disk_commit(
            &mut cache,
            &mut sync_state,
            false,
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
        let mut sync_state = DiskSyncState::Absent;
        let captured: std::sync::Arc<std::sync::Mutex<Option<Vec<String>>>> =
            std::sync::Arc::new(std::sync::Mutex::new(None));
        let captured_for_fn = captured.clone();

        let result = apply_with_disk_commit(
            &mut cache,
            &mut sync_state,
            false,
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
                    Ok(DiskFingerprint {
                        mtime_ms: None,
                        size: 0,
                        hash: String::new(),
                    })
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

    /// `external_change_merged=true` を渡した場合は MutationResult にそのまま伝搬する。
    /// #640 (write-ahead) と #642 (merge 検出) のフラグ合流を担保する。
    #[tokio::test]
    async fn apply_with_disk_commit_propagates_external_change_merged_flag() {
        let mut cache = vec![make_entry("a", "/proj/x", "2026-05-09T00:00:00Z")];
        let mut sync_state = DiskSyncState::Absent;

        let result = apply_with_disk_commit(
            &mut cache,
            &mut sync_state,
            true, // 外部変更を merge 済み
            |_candidate| {},
            |_entries| async {
                Ok(DiskFingerprint {
                    mtime_ms: None,
                    size: 0,
                    hash: String::new(),
                })
            },
        )
        .await;

        assert!(result.ok);
        assert!(
            result.external_change_merged,
            "external_change_merged must propagate to MutationResult"
        );
    }

    /// `compute_fingerprint` と `save_all` の round-trip。書き込み直後の fingerprint が
    /// disk と一致することを検証。
    #[tokio::test]
    async fn fingerprint_roundtrips_with_save_all() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("team-history.json");
        let entries = vec![entry("a", "hello", "2026-01-02T00:00:00Z")];

        let fp = save_all(&path, &entries).await.unwrap();
        let on_disk = compute_fingerprint(&path).await.unwrap();

        assert_eq!(fp, on_disk, "save_all returned fingerprint must match disk");
    }

    /// 外部書き換え (= disk を別経路で touch) 後に `compute_fingerprint` の結果が
    /// 変化することを検証。Issue #642 の検知ロジックの核。
    #[tokio::test]
    async fn fingerprint_detects_external_modification() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("team-history.json");
        let entries = vec![entry("a", "before", "2026-01-02T00:00:00Z")];
        let fp_before = save_all(&path, &entries).await.unwrap();

        // 外部編集をシミュレート: 別経路で disk を上書きする
        let external = vec![entry("a", "AFTER-EXTERNAL-EDIT", "2026-01-02T00:00:00Z")];
        let json = serde_json::to_vec_pretty(&external).unwrap();
        tokio::fs::write(&path, &json).await.unwrap();

        let fp_after = compute_fingerprint(&path).await.unwrap();
        assert_ne!(
            fp_before, fp_after,
            "external edit must change fingerprint (hash differs)"
        );
    }

    /// `merge_external_disk`: incoming_ids に含まれる id は cache 側 (in-process 変更) を優先。
    /// 同 id について disk 側が新しくても上書きしない。
    #[test]
    fn merge_keeps_in_process_change_for_incoming_id() {
        let mut cache = vec![entry("a", "in-process-new", "2026-01-03T00:00:00Z")];
        let disk = vec![entry("a", "disk-stale", "2026-01-02T00:00:00Z")];
        let mut incoming = HashSet::new();
        incoming.insert("a".to_string());

        let merged = merge_external_disk(&mut cache, disk, &incoming);

        assert!(!merged, "no other-id change → external_change_merged stays false");
        assert_eq!(cache.len(), 1);
        assert_eq!(
            cache[0]
                .orchestration
                .as_ref()
                .and_then(|o| o.blocked_reason.as_deref()),
            Some("in-process-new"),
            "incoming_id kept cache-side"
        );
    }

    /// disk-only entry は cache に取り込まれる (= 外部追加を保持)。
    #[test]
    fn merge_picks_up_disk_only_entry() {
        let mut cache = vec![entry("a", "in-process", "2026-01-03T00:00:00Z")];
        let disk = vec![
            entry("a", "in-process", "2026-01-03T00:00:00Z"),
            entry("b", "external-added", "2026-01-04T00:00:00Z"),
        ];
        let mut incoming = HashSet::new();
        incoming.insert("a".to_string());

        let merged = merge_external_disk(&mut cache, disk, &incoming);

        assert!(merged, "disk-only entry must trigger external_change_merged");
        assert_eq!(cache.len(), 2);
        let b = cache.iter().find(|e| e.id == "b").expect("b imported");
        assert_eq!(
            b.orchestration
                .as_ref()
                .and_then(|o| o.blocked_reason.as_deref()),
            Some("external-added"),
        );
    }

    /// disk 側で外部編集された entry (= incoming_ids に含まれない id) は disk 側を採用。
    /// stale-write を防ぐコア semantics。
    #[test]
    fn merge_picks_disk_for_externally_edited_non_incoming() {
        let mut cache = vec![
            entry("a", "in-process", "2026-01-03T00:00:00Z"),
            entry("b", "cache-stale", "2026-01-02T00:00:00Z"),
        ];
        let disk = vec![
            entry("a", "disk-stale-but-not-incoming", "2026-01-03T00:00:00Z"),
            entry("b", "disk-NEW-EXTERNAL-EDIT", "2026-01-02T00:00:00Z"),
        ];
        // incoming_ids に b は含めない → disk 側 (= 手編集) が勝つべき。
        let mut incoming = HashSet::new();
        incoming.insert("a".to_string());

        let merged = merge_external_disk(&mut cache, disk, &incoming);

        assert!(merged);
        let b = cache.iter().find(|e| e.id == "b").expect("b kept");
        assert_eq!(
            b.orchestration
                .as_ref()
                .and_then(|o| o.blocked_reason.as_deref()),
            Some("disk-NEW-EXTERNAL-EDIT"),
            "external edit on b must be preserved"
        );
        // a は incoming_id なので cache 側を保持
        let a = cache.iter().find(|e| e.id == "a").expect("a kept");
        assert_eq!(
            a.orchestration
                .as_ref()
                .and_then(|o| o.blocked_reason.as_deref()),
            Some("in-process"),
        );
    }

    /// disk の entry が cache と完全に同一の場合は merged=false (= 無駄に diff フラグを立てない)。
    #[test]
    fn merge_returns_false_when_disk_matches_cache() {
        let mut cache = vec![entry("a", "same", "2026-01-03T00:00:00Z")];
        let disk = vec![entry("a", "same", "2026-01-03T00:00:00Z")];
        let incoming = HashSet::new();

        let merged = merge_external_disk(&mut cache, disk, &incoming);

        assert!(!merged);
        assert_eq!(cache.len(), 1);
    }

    /// `reconcile_external_changes`: fingerprint が一致していれば disk を読み直さず no-op。
    #[tokio::test]
    async fn reconcile_skips_reload_when_fingerprint_matches() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("team-history.json");
        let entries = vec![entry("a", "x", "2026-01-03T00:00:00Z")];
        let fp = save_all(&path, &entries).await.unwrap();
        let mut cache = entries.clone();
        let mut sync_state = DiskSyncState::Synced(fp);
        let incoming = HashSet::new();

        let merged =
            reconcile_external_changes(&path, &mut cache, &mut sync_state, &incoming).await;

        assert!(!merged, "fingerprint match → no merge");
        assert_eq!(cache.len(), 1);
    }

    /// `reconcile_external_changes`: 外部編集後に呼ぶと disk 側 entry が cache に取り込まれる。
    /// Issue #642 の中核検証 — 「auto-save が手編集を blind overwrite する」事故を防ぐパス。
    #[tokio::test]
    async fn reconcile_merges_external_edit_before_save() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("team-history.json");

        // Step 1: 初期 disk = entry "b" を保存
        let initial = vec![entry("b", "original-summary", "2026-01-02T00:00:00Z")];
        let fp = save_all(&path, &initial).await.unwrap();

        // Step 2: in-memory cache は entry "a" を新規追加した状態 (entry "b" の内容は古い copy)
        let mut cache = vec![
            entry("b", "original-summary", "2026-01-02T00:00:00Z"),
            entry("a", "new-from-app", "2026-01-03T00:00:00Z"),
        ];
        let mut sync_state = DiskSyncState::Synced(fp);

        // Step 3: ユーザーが外部 (jq 等) で disk の entry "b" の summary を直接編集
        let externally_edited = vec![entry("b", "user-hand-edited!", "2026-01-02T00:00:00Z")];
        let json = serde_json::to_vec_pretty(&externally_edited).unwrap();
        tokio::fs::write(&path, &json).await.unwrap();

        // Step 4: app 側で entry "a" を save しようとする (= incoming_ids = {"a"})
        let mut incoming = HashSet::new();
        incoming.insert("a".to_string());

        let merged =
            reconcile_external_changes(&path, &mut cache, &mut sync_state, &incoming).await;

        assert!(merged, "external edit on 'b' must be detected");
        // cache の "b" は disk 側 (手編集) で上書きされている
        let b = cache.iter().find(|e| e.id == "b").expect("b present");
        assert_eq!(
            b.orchestration
                .as_ref()
                .and_then(|o| o.blocked_reason.as_deref()),
            Some("user-hand-edited!"),
            "external edit must override stale cache copy",
        );
        // cache の "a" (incoming_id) は cache 側を保持
        let a = cache.iter().find(|e| e.id == "a").expect("a present");
        assert_eq!(
            a.orchestration
                .as_ref()
                .and_then(|o| o.blocked_reason.as_deref()),
            Some("new-from-app"),
        );
        // sync_state は disk 側に更新されている (= Synced)
        assert!(
            sync_state.synced_fingerprint().is_some(),
            "sync_state must be Synced after external reload"
        );
    }

    /// disk のファイルが存在しない (= 初回 save 前) ケースで、`reconcile_external_changes` が
    /// fingerprint なし (= Absent) と一致して no-op になる。
    #[tokio::test]
    async fn reconcile_no_op_when_disk_absent_and_fingerprint_absent() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("team-history.json");
        let mut cache: Vec<TeamHistoryEntry> = vec![];
        let mut sync_state = DiskSyncState::Absent;
        let incoming = HashSet::new();

        let merged =
            reconcile_external_changes(&path, &mut cache, &mut sync_state, &incoming).await;
        assert!(!merged);
        assert!(cache.is_empty());
    }

    /// MutationResult の serde 互換性: external_change_merged=false のときは JSON に出さない
    /// (renderer 側 `interface MutationResult { ok; error? }` を破らない)。
    #[test]
    fn mutation_result_omits_external_change_merged_when_false() {
        let r = MutationResult {
            ok: true,
            error: None,
            external_change_merged: false,
        };
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("\"ok\":true"), "json={json}");
        assert!(
            !json.contains("externalChangeMerged"),
            "false case should be omitted, json={json}"
        );
    }

    /// MutationResult の serde 互換性: external_change_merged=true のときは camelCase で出力。
    #[test]
    fn mutation_result_emits_external_change_merged_when_true() {
        let r = MutationResult {
            ok: true,
            error: None,
            external_change_merged: true,
        };
        let json = serde_json::to_string(&r).unwrap();
        assert!(
            json.contains("\"externalChangeMerged\":true"),
            "expected camelCase field, json={json}"
        );
    }
}

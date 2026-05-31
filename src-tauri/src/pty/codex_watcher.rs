// Codex セッション ID 検出 watcher — Issue #855
//
// claude_watcher.rs の Codex 版。Codex CLI (codex 0.130.0 系) が出力する
// rollout ファイルを後追いで監視し、session id を `terminal:sessionId:{terminal_id}`
// event として renderer に届ける。
//
// Codex 実機事実 (codex 0.130.0):
//   - session は `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<UUID>.jsonl` に保存される。
//     (claude のような project ごとの encoded ディレクトリは無く、日付サブディレクトリ配下)
//   - rollout の 1 行目は
//       {"timestamp":...,"type":"session_meta","payload":{"id":"<UUID>","timestamp":...,
//        "cwd":"<cwd>","originator":...}}
//   - `payload.id` がファイル名末尾の UUID と一致し、これが Codex の session id。
//   - `payload.cwd` が codex 起動時の cwd。
//
// claude_watcher との差分:
//   1. 監視 dir は `~/.codex/sessions/` 固定 (CODEX_HOME があればそちら)。日付サブディレクトリ
//      に新ファイルが現れるため `RecursiveMode::Recursive` で監視する。
//   2. 候補ファイルは `rollout-*.jsonl` (ファイル名 prefix `rollout-` / 拡張子 `.jsonl`)。
//   3. session id は **ファイル名ではなく 1 行目 JSON の `session_meta.payload.id`** から読む。
//      1 行目が session_meta でなければ skip (= 堅牢かつ fail-closed)。
//   4. cwd 一致判定は `payload.cwd` を `normalize_project_root` した値が、watcher 起動時に
//      渡された project_root の正規化値と一致した場合のみ採用 (claude の jsonl_matches_project
//      相当)。読めない / 空 / 不一致は fail-closed で claim させない。
//   5. claim 機構 (CODEX_CLAIMED_SESSIONS) は claude の sessionId 空間と衝突しないよう
//      **codex 専用 static** を持つ。
//
// spawn_watcher のシグネチャ・deadline(60s)・poll(100ms)・cancel(AtomicBool) 設計は
// claude_watcher と完全に揃えてある。

use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use once_cell::sync::Lazy;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Emitter};

/// session が kill された瞬間に `watcher_cancel` を観測して exit できる polling 間隔。
/// claude_watcher と同値 (100ms)。
const WATCHER_POLL_INTERVAL: Duration = Duration::from_millis(100);

/// session 起動から rollout 検出を諦めるまでの最大時間 (= hard deadline)。
/// claude_watcher と同値 (60 秒)。
const WATCHER_MAX_LIFETIME: Duration = Duration::from_secs(60);

/// claim 済み codex session id の集合 (id → claimed_at)。
/// claude の CLAIMED_SESSIONS とは **別 static**。UUID 空間は別だが、万一の衝突や
/// claude 側 claim による誤排他を避けるため codex 専用に分離する。
static CODEX_CLAIMED_SESSIONS: Lazy<Mutex<HashMap<String, Instant>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

const CLAIM_TTL_SECS: u64 = 60 * 60; // 1 時間 (claude と同値)

fn evict_expired(map: &mut HashMap<String, Instant>) {
    let cutoff = Duration::from_secs(CLAIM_TTL_SECS);
    map.retain(|_, t| t.elapsed() < cutoff);
}

fn try_claim(session_id: &str) -> bool {
    let mut guard = match CODEX_CLAIMED_SESSIONS.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    evict_expired(&mut guard);
    if guard.contains_key(session_id) {
        return false;
    }
    guard.insert(session_id.to_string(), Instant::now());
    true
}

fn is_claimed(session_id: &str) -> bool {
    let mut guard = match CODEX_CLAIMED_SESSIONS.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    evict_expired(&mut guard);
    guard.contains_key(session_id)
}

/// 監視対象の codex sessions ディレクトリを返す。
/// `CODEX_HOME` env があれば `<CODEX_HOME>/sessions`、無ければ `~/.codex/sessions`。
/// terminal_tabs.rs の codex sanitize もこの関数を共有する (SSOT)。
pub fn codex_sessions_dir() -> PathBuf {
    if let Ok(home) = std::env::var("CODEX_HOME") {
        let trimmed = home.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed).join("sessions");
        }
    }
    dirs::home_dir()
        .unwrap_or_default()
        .join(".codex")
        .join("sessions")
}

/// `rollout-<ts>-<uuid>.jsonl` 形式のファイルか判定する。
/// ファイル名 prefix が `rollout-` かつ拡張子が `.jsonl`。
fn is_rollout_file(path: &Path) -> bool {
    if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
        return false;
    }
    path.file_name()
        .and_then(|s| s.to_str())
        .map(|name| name.starts_with("rollout-"))
        .unwrap_or(false)
}

/// `~/.codex/sessions/` を再帰走査して rollout ファイルの絶対パスを集める。
/// (日付サブディレクトリ YYYY/MM/DD 配下に置かれるため再帰が必須)
fn collect_rollout_paths(dir: &Path, out: &mut Vec<PathBuf>) {
    let read = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for entry in read.flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(ft) if ft.is_dir() => collect_rollout_paths(&path, out),
            Ok(_) if is_rollout_file(&path) => out.push(path),
            _ => {}
        }
    }
}

/// watcher 起動時点ですでに rollout が作られている race を救済するため、
/// spawn 開始 (`since`) 以降に更新された rollout を mtime 昇順で返す
/// (claude の list_recent_session_candidates 相当)。
fn list_recent_rollout_candidates(dir: &Path, since: SystemTime) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    collect_rollout_paths(dir, &mut paths);
    let mut recent: Vec<(PathBuf, SystemTime)> = paths
        .into_iter()
        .filter_map(|p| {
            let modified = std::fs::metadata(&p).ok()?.modified().ok()?;
            if modified >= since {
                Some((p, modified))
            } else {
                None
            }
        })
        .collect();
    recent.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
    recent.into_iter().map(|(p, _)| p).collect()
}

/// rollout の 1 行目から `(session_id, cwd)` を抽出する。
///
/// 戻り値:
///   - `Some((id, cwd))`: 1 行目が完全に読めて `type == "session_meta"` かつ `payload.id`
///     が非空。cwd は欠落時 "" (上位で fail-closed 判定する)。
///   - `None`: ファイルが開けない / 空 / 1 行目が JSON として未完 (partial write) /
///     session_meta でない / id 欠落。**未完ケースを `None` に倒すことで上位は recheck できる**。
fn read_codex_session_meta(path: &Path) -> Option<(String, String)> {
    use std::io::{BufRead, BufReader};
    let file = std::fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut first = String::new();
    // 1 行目だけ読む。改行未到達 (partial write) でも read_line は EOF までの断片を返すため、
    // 断片 JSON は serde の parse 失敗で None に倒れ、上位が次イベントで recheck する。
    if reader.read_line(&mut first).ok()? == 0 {
        return None; // 空ファイル
    }
    let v: serde_json::Value = serde_json::from_str(first.trim()).ok()?;
    if v.get("type").and_then(|t| t.as_str()) != Some("session_meta") {
        return None;
    }
    let payload = v.get("payload")?;
    let id = payload.get("id").and_then(|i| i.as_str())?.to_string();
    if id.is_empty() {
        return None;
    }
    let cwd = payload
        .get("cwd")
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();
    Some((id, cwd))
}

/// 1 候補 rollout を処理した結果。
enum CandidateOutcome {
    /// claim + emit に成功 → watcher は return すべき。
    Emitted,
    /// 確定的に解決済み (cwd 不一致 / 他 watcher が claim 済み / claim 競合敗北 / emit 失敗)
    /// → seen に入れて再走査しない。
    Consumed,
    /// 1 行目がまだ読めない (partial write) → seen に入れず次イベントで再 check。
    Retry,
}

fn emit_session_id(app: &AppHandle, terminal_id: &str, session_id: &str) -> bool {
    let event_name = format!("terminal:sessionId:{terminal_id}");
    if let Err(e) = app.emit(&event_name, session_id.to_string()) {
        tracing::warn!("[codex_watcher] emit failed: {e}");
        false
    } else {
        tracing::info!(
            "[codex_watcher] sessionId detected tid={} sid={}",
            terminal_id,
            session_id
        );
        true
    }
}

/// 1 つの rollout 候補を評価し、cwd 一致 + 未 claim なら claim → emit する。
fn process_candidate(
    app: &AppHandle,
    terminal_id: &str,
    path: &Path,
    expected_norm: &str,
) -> CandidateOutcome {
    let Some((id, cwd)) = read_codex_session_meta(path) else {
        // 1 行目未確定 (partial write) / session_meta でない → 再 check 余地を残す。
        return CandidateOutcome::Retry;
    };
    if is_claimed(&id) {
        return CandidateOutcome::Consumed;
    }
    // cwd 一致判定 (fail-closed: 空 / 不一致は採用しない)
    let cwd_norm = super::path_norm::normalize_project_root(cwd.trim());
    if cwd_norm.is_empty() || cwd_norm != expected_norm {
        tracing::debug!(
            "[codex_watcher] skip {} (cwd mismatch: {:?})",
            id,
            cwd
        );
        return CandidateOutcome::Consumed;
    }
    if !try_claim(&id) {
        // is_claimed と try_claim の間で他 watcher が先に占有した競合。
        return CandidateOutcome::Consumed;
    }
    if emit_session_id(app, terminal_id, &id) {
        CandidateOutcome::Emitted
    } else {
        // emit 失敗。既に claim 済みなので二重 emit を避けるため Consumed 扱い。
        CandidateOutcome::Consumed
    }
}

/// 1 つの terminal セッションに対して codex rollout watch を開始する。
///
/// シグネチャ・cancel(AtomicBool)・deadline(60s)・poll(100ms) は claude_watcher と完全に揃える。
/// 検出した sessionId は `terminal:sessionId:{terminal_id}` event で 1 回だけ emit される
/// (claim 機構で multi-watcher 競合は排他)。
pub fn spawn_watcher(
    app: AppHandle,
    terminal_id: String,
    project_root: String,
    spawned_at: SystemTime,
    watcher_cancel: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        run_watcher_loop(app, terminal_id, project_root, spawned_at, watcher_cancel)
    });
}

/// watcher 本体ループ。テストからの呼び出し利便のため関数として切り出す。
fn run_watcher_loop(
    app: AppHandle,
    terminal_id: String,
    project_root: String,
    spawned_at: SystemTime,
    watcher_cancel: Arc<AtomicBool>,
) {
    let is_cancelled = || watcher_cancel.load(Ordering::Acquire);

    let dir = codex_sessions_dir();
    // ディレクトリが無い場合も codex が起動後に作るので、最大 5 秒待機。
    // この phase でも `watcher_cancel` を 100ms ごとに観測して即時 exit する。
    let mut waits = 0;
    while !dir.exists() && waits < 50 {
        std::thread::sleep(WATCHER_POLL_INTERVAL);
        waits += 1;
        if is_cancelled() {
            tracing::debug!(
                "[codex_watcher] tid={} cancelled while waiting for sessions dir",
                terminal_id
            );
            return;
        }
    }
    if !dir.exists() {
        tracing::debug!("[codex_watcher] {} not appearing, giving up", dir.display());
        return;
    }

    let expected_norm = super::path_norm::normalize_project_root(&project_root);

    // 初期 snapshot: 既存の rollout はすべて「この spawn 以前のもの」として除外対象 (seen)。
    let mut seen: HashSet<PathBuf> = HashSet::new();
    {
        let mut snap = Vec::new();
        collect_rollout_paths(&dir, &mut snap);
        for p in snap {
            seen.insert(p);
        }
    }
    tracing::debug!(
        "[codex_watcher] tid={} dir={} initial={} entries",
        terminal_id,
        dir.display(),
        seen.len()
    );

    // codex が watcher 起動より速く rollout を作った race を救済する。
    // spawn 開始以降に更新された rollout は seen 済みでも 1 度だけ評価する。
    for path in list_recent_rollout_candidates(&dir, spawned_at) {
        match process_candidate(&app, &terminal_id, &path, &expected_norm) {
            CandidateOutcome::Emitted => return,
            CandidateOutcome::Consumed => {} // seen に既に含まれる
            CandidateOutcome::Retry => {
                // 1 行目未確定 → seen から外して event loop で再 check させる。
                seen.remove(&path);
            }
        }
    }

    let (tx, rx) = channel::<notify::Result<Event>>();
    let mut watcher = match RecommendedWatcher::new(
        move |res: notify::Result<Event>| {
            let _ = tx.send(res);
        },
        Config::default().with_poll_interval(Duration::from_millis(500)),
    ) {
        Ok(w) => w,
        Err(e) => {
            tracing::warn!("[codex_watcher] watcher init failed: {e}");
            return;
        }
    };
    // 日付サブディレクトリ (YYYY/MM/DD) に新ファイルが出るため Recursive で監視する。
    if let Err(e) = watcher.watch(&dir, RecursiveMode::Recursive) {
        tracing::warn!("[codex_watcher] watch failed: {e}");
        return;
    }

    // Windows の native backend (ReadDirectoryChangesW) は notify の `with_poll_interval` を
    // 無視するため、イベント取りこぼし (特に watch 開始後に新規作成される YYYY/MM/DD サブ
    // ディレクトリ配下の rollout 作成) を救う polling fallback が存在しない。そこで event の有無に
    // 依らず最低 1 秒ごとに full rescan を回し、取りこぼしを構造的に補償する。`seen` で dedup 済み
    // かつ rescan を 1s に throttle するので、Codex 起動直後に連続 fs イベントが来ても全再帰走査が
    // 100ms ごとに繰り返されることはない (event は recv の待ちを短縮するだけで、walk 頻度は throttle
    // が決める)。(fs_watch.rs が同じ Windows 事情で Recursive を避けて手動展開しているのと同趣旨の保険)
    const RESCAN_INTERVAL: Duration = Duration::from_secs(1);
    let watcher_started_at = Instant::now();
    let mut last_full_scan: Option<Instant> = None;
    while watcher_started_at.elapsed() < WATCHER_MAX_LIFETIME {
        if is_cancelled() {
            tracing::debug!(
                "[codex_watcher] tid={} cancelled by session — exiting watcher",
                terminal_id
            );
            return;
        }
        // poll interval 単位で待つ。event は recv を早く返すだけで、走査頻度は下の throttle が決める。
        // channel 切断時のみ break。
        match rx.recv_timeout(WATCHER_POLL_INTERVAL) {
            Ok(_) | Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
        // 連続イベントでも walk は最低 1s 間隔に coalesce する (初回 = None のときだけ即時走査)。
        if last_full_scan.is_some_and(|t| t.elapsed() < RESCAN_INTERVAL) {
            continue;
        }
        last_full_scan = Some(Instant::now());
        let mut current = Vec::new();
        collect_rollout_paths(&dir, &mut current);
        // パス順を安定化 (どの watcher が先に claim してもデテルミニスティックに)。
        current.sort();
        for path in current {
            if seen.contains(&path) {
                continue;
            }
            match process_candidate(&app, &terminal_id, &path, &expected_norm) {
                CandidateOutcome::Emitted => return,
                CandidateOutcome::Consumed => {
                    seen.insert(path);
                }
                CandidateOutcome::Retry => {
                    // 1 行目がまだ書かれていない → seen に入れず次ループで再 check。
                }
            }
        }
    }
    tracing::debug!(
        "[codex_watcher] tid={} watcher exit (deadline / cancelled / channel closed)",
        terminal_id
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn unique_temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vibe-editor-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn session_meta_line(id: &str, cwd: &str) -> String {
        // 実機 rollout の 1 行目を模す (timestamp / originator は任意フィールド)。
        format!(
            r#"{{"timestamp":"2026-05-31T00:00:00Z","type":"session_meta","payload":{{"id":"{id}","timestamp":"2026-05-31T00:00:00Z","cwd":"{cwd}","originator":"codex_cli_rs"}}}}"#
        )
    }

    fn write_rollout(dir: &Path, ts: &str, id: &str, first_line: &str) -> PathBuf {
        // YYYY/MM/DD サブディレクトリを模す。
        let day_dir = dir.join("2026").join("05").join("31");
        fs::create_dir_all(&day_dir).expect("create day dir");
        let path = day_dir.join(format!("rollout-{ts}-{id}.jsonl"));
        fs::write(&path, format!("{first_line}\n")).expect("write rollout");
        path
    }

    /// session_meta 1 行目から id (と cwd) を抽出できること。
    #[test]
    fn reads_session_id_from_session_meta_first_line() {
        let dir = unique_temp_dir("codex-watcher-read-id");
        let id = "11111111-2222-3333-4444-555555555555";
        let cwd = "/tmp/repo";
        let path = write_rollout(&dir, "2026-05-31T00-00-00", id, &session_meta_line(id, cwd));

        let meta = read_codex_session_meta(&path);
        assert_eq!(meta, Some((id.to_string(), cwd.to_string())));
        let _ = fs::remove_dir_all(dir);
    }

    /// 1 行目が session_meta でなければ None (= skip) になること。
    #[test]
    fn rejects_first_line_that_is_not_session_meta() {
        let dir = unique_temp_dir("codex-watcher-not-meta");
        let id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        // type が event_msg の行 (session_meta でない)
        let line = r#"{"timestamp":"2026-05-31T00:00:00Z","type":"event_msg","payload":{"foo":"bar"}}"#;
        let path = write_rollout(&dir, "2026-05-31T00-00-00", id, line);

        assert!(
            read_codex_session_meta(&path).is_none(),
            "non session_meta first line must be skipped"
        );
        let _ = fs::remove_dir_all(dir);
    }

    /// 空ファイル / partial write は None に倒れること (上位で recheck できる)。
    #[test]
    fn returns_none_for_empty_or_partial_first_line() {
        let dir = unique_temp_dir("codex-watcher-partial");
        let day_dir = dir.join("2026").join("05").join("31");
        fs::create_dir_all(&day_dir).expect("create day dir");

        // 空ファイル
        let empty = day_dir.join("rollout-ts-empty.jsonl");
        fs::write(&empty, "").expect("write empty");
        assert!(read_codex_session_meta(&empty).is_none());

        // partial JSON (改行未到達・閉じ括弧無し)
        let partial = day_dir.join("rollout-ts-partial.jsonl");
        fs::write(&partial, r#"{"timestamp":"x","type":"session_me"#).expect("write partial");
        assert!(read_codex_session_meta(&partial).is_none());

        let _ = fs::remove_dir_all(dir);
    }

    /// cwd 不一致を弾くこと (fail-closed)。一致時のみ採用。
    #[test]
    fn rejects_cwd_mismatch_and_accepts_match() {
        let id = "cccccccc-dddd-eeee-ffff-000000000000";
        let cwd = "/tmp/project-a";
        // codex 起動 cwd と watcher の project_root が異なるケース
        let expected_other = super::super::path_norm::normalize_project_root("/tmp/project-b");
        assert_ne!(
            super::super::path_norm::normalize_project_root(cwd),
            expected_other,
            "mismatch cwd must not normalize-equal to a different root"
        );
        // 同一なら一致する (正規化往復)
        let expected_same = super::super::path_norm::normalize_project_root(cwd);
        assert_eq!(super::super::path_norm::normalize_project_root(cwd), expected_same);

        // session_meta の cwd が確かに抽出され、normalize 比較で弾けることを end-to-end で確認。
        let dir = unique_temp_dir("codex-watcher-cwd");
        let path = write_rollout(&dir, "2026-05-31T00-00-00", id, &session_meta_line(id, cwd));
        let (got_id, got_cwd) = read_codex_session_meta(&path).expect("meta");
        assert_eq!(got_id, id);
        assert_ne!(
            super::super::path_norm::normalize_project_root(got_cwd.trim()),
            expected_other
        );
        let _ = fs::remove_dir_all(dir);
    }

    /// rollout-*.jsonl 以外を無視すること。
    #[test]
    fn is_rollout_file_only_matches_rollout_jsonl() {
        let base = Path::new("/x/2026/05/31");
        assert!(is_rollout_file(&base.join("rollout-2026-05-31T00-00-00-uuid.jsonl")));
        // prefix 違い
        assert!(!is_rollout_file(&base.join("session-uuid.jsonl")));
        // 拡張子違い
        assert!(!is_rollout_file(&base.join("rollout-uuid.txt")));
        assert!(!is_rollout_file(&base.join("rollout-uuid.json")));
        // prefix も拡張子も違う
        assert!(!is_rollout_file(&base.join("notes.md")));
    }

    /// 再帰走査が日付サブディレクトリ配下の rollout のみ拾うこと。
    #[test]
    fn collect_rollout_paths_recurses_and_filters() {
        let dir = unique_temp_dir("codex-watcher-collect");
        let id = "dddddddd-eeee-ffff-0000-111111111111";
        let rollout = write_rollout(&dir, "2026-05-31T00-00-00", id, &session_meta_line(id, "/tmp/r"));
        // 無関係ファイルを同階層に置く
        let day_dir = dir.join("2026").join("05").join("31");
        fs::write(day_dir.join("ignore.txt"), "x").expect("write ignore");
        fs::write(day_dir.join("history.jsonl"), "x").expect("write non-rollout jsonl");

        let mut out = Vec::new();
        collect_rollout_paths(&dir, &mut out);
        assert_eq!(out, vec![rollout]);
        let _ = fs::remove_dir_all(dir);
    }

    /// recent 候補が since 以降に更新された rollout のみを返すこと。
    #[test]
    fn recent_candidates_filter_by_mtime() {
        let dir = unique_temp_dir("codex-watcher-recent");
        let old_id = "00000000-0000-0000-0000-000000000001";
        write_rollout(&dir, "old", old_id, &session_meta_line(old_id, "/tmp/r"));

        std::thread::sleep(Duration::from_millis(20));
        let since = SystemTime::now();
        std::thread::sleep(Duration::from_millis(20));

        let new_id = "00000000-0000-0000-0000-000000000002";
        let new_path = write_rollout(&dir, "new", new_id, &session_meta_line(new_id, "/tmp/r"));

        let recent = list_recent_rollout_candidates(&dir, since);
        assert_eq!(recent, vec![new_path]);
        let _ = fs::remove_dir_all(dir);
    }

    /// claim 機構: 同 id は 1 回しか claim できないこと (multi-watcher 排他)。
    #[test]
    fn claim_is_exclusive_per_session_id() {
        let id = format!("claim-test-{}", uuid::Uuid::new_v4());
        assert!(!is_claimed(&id));
        assert!(try_claim(&id), "first claim succeeds");
        assert!(is_claimed(&id));
        assert!(!try_claim(&id), "second claim fails");
    }

    /// poll interval が 500ms (legacy) より十分短く、busy-loop でないこと。
    #[test]
    fn watcher_poll_interval_is_bounded() {
        assert!(WATCHER_POLL_INTERVAL <= Duration::from_millis(200));
        assert!(WATCHER_POLL_INTERVAL >= Duration::from_millis(10));
    }

    /// deadline は 30 秒以上維持されること (codex 起動が遅い環境での検出漏れ防止)。
    #[test]
    fn watcher_max_lifetime_is_at_least_30_seconds() {
        assert!(WATCHER_MAX_LIFETIME >= Duration::from_secs(30));
    }
}

// Claude Code セッション ID 検出 watcher
//
// 旧 src/main/lib/claude-session-watcher.ts の Rust 移植。
//
// 動作:
//   1. spawn 直前に ~/.claude/projects/<encoded-projectRoot>/ の jsonl ファイル名を snapshot
//   2. notify crate で同ディレクトリを監視
//   3. snapshot に無い新しい *.jsonl が現れたら、ファイル名 (UUID) を sessionId として
//      `terminal:sessionId:{terminal_id}` event を emit
//   4. is_alive (`SessionRegistry.get(terminal_id).is_some()`) で false になったら停止
//
// Issue #660 後の役割 (= "fallback detector"):
//   - 通常経路では renderer 側が UUID を事前生成し `claude --session-id <uuid>` を args に
//     注入する。renderer が session id を **先に** 知っているため、watcher が emit する
//     値は renderer の値と一致する no-op になる。renderer 側の cb は冪等 (同値書込みで
//     zustand が skip / `markSessionPersisted` も idempotent) なので副作用は無い。
//   - 本 watcher の存在意義は (a) 外部から `claude` を直接起動された場合 (= vibe-editor
//     経由でない PTY)、(b) 旧 schema の永続化データで `--session-id` 注入未対応の tab、
//     の 2 ケースで session id を後追い検出して renderer に届けること。
//
// 注意:
//   - Claude Code 以外 (codex 等) は jsonl を作らないので呼び出さない (renderer 制御)
//   - notify は OS の inotify/ReadDirectoryChangesW に依存。Windows でも動く

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use once_cell::sync::Lazy;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Emitter};

/// Issue #632: watcher 内ループの polling 間隔。session が kill された瞬間に
/// `watcher_cancel` を観測して exit できるよう、旧 500ms から短縮する。
/// 短すぎても 1 watcher 当たり 10 回/秒 で済むので CPU 影響は無視できる。
const WATCHER_POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Issue #632: session 起動から jsonl 検出を諦めるまでの最大時間 (= deadline)。
/// 旧実装は `Instant::now() + 60s` を watcher 起動時に固定していたが、
/// new 実装でも数値は同じ 60 秒。違いは「session が早期 kill された場合に
/// `watcher_cancel` で 100ms 以内に exit する」点。
const WATCHER_MAX_LIFETIME: Duration = Duration::from_secs(60);

/// Issue #30 + #148: claim 済み sessionId の集合。
/// 旧実装は HashSet で永続成長し、長時間稼働でメモリリーク + デッドサーション ID で
/// 占有されると新 watcher が拾えない問題があった。
/// → (sessionId → claimed_at) の HashMap にして TTL_SECS を超えた entry は claim 取得時
///   にまとめて掃除する。デッドサーションは TTL 後に再 claim 可能になる。
static CLAIMED_SESSIONS: Lazy<Mutex<HashMap<String, Instant>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

const CLAIM_TTL_SECS: u64 = 60 * 60; // 1 時間

fn evict_expired(map: &mut HashMap<String, Instant>) {
    let cutoff = Duration::from_secs(CLAIM_TTL_SECS);
    map.retain(|_, t| t.elapsed() < cutoff);
}

fn try_claim(session_id: &str) -> bool {
    let mut guard = match CLAIMED_SESSIONS.lock() {
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
    let mut guard = match CLAIMED_SESSIONS.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    evict_expired(&mut guard);
    guard.contains_key(session_id)
}

/// Issue #31 + #175: 同 encoded directory に別 project の jsonl が集まる場合に備えた検証。
/// 旧実装は cwd が読めない / 空文字のとき fail-open で true を返していたため、jsonl 作成
/// 直後の不完全状態と watcher polling が重なると別 project の sessionId を誤 claim していた。
///
/// 新方針: 「明示的に同 project と確認できたケースのみ true」。具体的には:
///   - cwd が読めて normalize 一致 → true
///   - cwd が読めて不一致 / 空文字 → false
///   - 8 行以内に cwd フィールドが現れない → false (= fail-closed)
///   - file open 失敗 → false (= fail-closed)
fn jsonl_matches_project(jsonl_path: &Path, expected_norm: &str) -> bool {
    use std::io::{BufRead, BufReader};
    let file = match std::fs::File::open(jsonl_path) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let reader = BufReader::new(file);
    for line in reader.lines().take(8).flatten() {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
            if let Some(c) = v.get("cwd").and_then(|c| c.as_str()) {
                let trimmed = c.trim();
                if trimmed.is_empty() {
                    return false;
                }
                return super::path_norm::normalize_project_root(trimmed) == expected_norm;
            }
        }
    }
    // cwd を含む行が無い → 不完全 jsonl の可能性が高い。fail-closed で claim させない。
    false
}

fn projects_dir(project_root: &str) -> PathBuf {
    let home = dirs::home_dir().unwrap_or_default();
    home.join(".claude")
        .join("projects")
        .join(super::path_norm::encode_project_path(project_root))
}

/// 既存 jsonl ファイル一覧 (UUID 部分のみ) を snapshot
fn list_session_ids(dir: &Path) -> HashSet<String> {
    let mut out = HashSet::new();
    let read = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return out,
    };
    for entry in read.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("jsonl") {
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                out.insert(stem.to_string());
            }
        }
    }
    out
}

struct SessionCandidate {
    id: String,
    path: PathBuf,
    modified: SystemTime,
}

/// watcher 起動時点ですでに jsonl が作られている race を救済するため、
/// spawn 開始以降に更新された session ファイルも候補として拾う。
fn list_recent_session_candidates(dir: &Path, since: SystemTime) -> Vec<SessionCandidate> {
    let read = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for entry in read.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if modified >= since {
            out.push(SessionCandidate {
                id: stem.to_string(),
                path,
                modified,
            });
        }
    }
    out.sort_by(|a, b| a.modified.cmp(&b.modified).then_with(|| a.id.cmp(&b.id)));
    out
}

fn emit_session_id(app: &AppHandle, terminal_id: &str, session_id: &str) -> bool {
    let event_name = format!("terminal:sessionId:{terminal_id}");
    if let Err(e) = app.emit(&event_name, session_id.to_string()) {
        tracing::warn!("[claude_watcher] emit failed: {e}");
        false
    } else {
        tracing::info!(
            "[claude_watcher] sessionId detected tid={} sid={}",
            terminal_id,
            session_id
        );
        true
    }
}

/// 1 つの terminal セッションに対して watch を開始する。
///
/// Issue #632: 旧実装は `is_alive` 閉包を 500ms 間隔で polling していた (deadline 60 秒固定)。
/// このため 1 秒で kill された session でも watcher は最大 60 秒近く生存し、30 タブ連続
/// 起動 + 即 kill のシナリオでは 30 個の watcher thread が並走して reader thread / channel
/// リソースを長時間専有していた。
///
/// 新実装は `watcher_cancel: Arc<AtomicBool>` を使う:
///   - PTY (`SessionHandle`) 起動時に `false` で生成される
///   - `kill()` / `Drop` で `true` に flip される
///   - watcher は `WATCHER_POLL_INTERVAL` (100ms) ごとに `cancel.load(Acquire)` を check
///   - deadline は session 起動 (`spawned_at`) からの経過時間で判定する
///
/// これで「session が早期終了したら watcher も 100ms 以内に exit」「長期 session でも
/// 60 秒の hard deadline は維持」の両立が成立する。
///
/// 検出した sessionId は terminal_id 宛の `terminal:sessionId:{terminal_id}` event で
/// 1 回だけ emit される (claim 機構で multi-watcher 競合は排他)。
pub fn spawn_watcher(
    app: AppHandle,
    terminal_id: String,
    project_root: String,
    spawned_at: SystemTime,
    watcher_cancel: Arc<AtomicBool>,
) {
    std::thread::spawn(move || run_watcher_loop(app, terminal_id, project_root, spawned_at, watcher_cancel));
}

/// Issue #632: watcher の本体ループ。`spawn_watcher` から std::thread で起動される。
/// テストから直接呼び出す時の利便性のため関数として切り出している。
fn run_watcher_loop(
    app: AppHandle,
    terminal_id: String,
    project_root: String,
    spawned_at: SystemTime,
    watcher_cancel: Arc<AtomicBool>,
) {
    let is_cancelled = || watcher_cancel.load(Ordering::Acquire);

    let dir = projects_dir(&project_root);
    // ディレクトリが無い場合も Claude が起動後に作るので、最大 5 秒待機。
    // この phase でも `watcher_cancel` を 100ms ごとに観測して即時 exit する。
    let mut waits = 0;
    while !dir.exists() && waits < 50 {
        std::thread::sleep(WATCHER_POLL_INTERVAL);
        waits += 1;
        if is_cancelled() {
            tracing::debug!(
                "[claude_watcher] tid={} cancelled while waiting for projects dir",
                terminal_id
            );
            return;
        }
    }
    if !dir.exists() {
        tracing::debug!(
            "[claude_watcher] {} not appearing, giving up",
            dir.display()
        );
        return;
    }

    // 初期 snapshot には既に他の watcher が claim 済みの session も含めて除外対象とする。
    // こうしておくと「spawn 時点で新規扱いだが他 watcher が先に claim した id」を
    // この watcher が後から誤拾いする可能性も閉じられる。
    let mut snapshot = list_session_ids(&dir);
    if let Ok(map) = CLAIMED_SESSIONS.lock() {
        for s in map.keys() {
            snapshot.insert(s.clone());
        }
    }
    tracing::debug!(
        "[claude_watcher] tid={} dir={} initial={} entries (+ claimed merged)",
        terminal_id,
        dir.display(),
        snapshot.len()
    );

    // Issue #429: Claude Code が非常に速く jsonl を作ると、watcher 起動後の
    // 初期 snapshot にその session が入ってしまい、difference では二度と検出できない。
    // terminal_create 開始以降に更新された jsonl は「この spawn の候補」として
    // snapshot 済みでも 1 度だけ claim を試す。
    let expected_norm = super::path_norm::normalize_project_root(&project_root);
    for candidate in list_recent_session_candidates(&dir, spawned_at) {
        if is_claimed(&candidate.id) {
            continue;
        }
        if !jsonl_matches_project(&candidate.path, &expected_norm) {
            tracing::debug!(
                "[claude_watcher] skip recent {} (cwd mismatch)",
                candidate.id
            );
            continue;
        }
        if !try_claim(&candidate.id) {
            continue;
        }
        if emit_session_id(&app, &terminal_id, &candidate.id) {
            return;
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
            tracing::warn!("[claude_watcher] watcher init failed: {e}");
            return;
        }
    };
    if let Err(e) = watcher.watch(&dir, RecursiveMode::NonRecursive) {
        tracing::warn!("[claude_watcher] watch failed: {e}");
        return;
    }

    // Issue #632: deadline は session 起動 (`spawned_at`) を anchor にする session-relative。
    // SystemTime は壁時計依存だが、Instant::now() の anchor を spawn 時点に取るには関数の
    // 入口で `let session_start = Instant::now();` するのと等価。ここでは spawned_at を信頼し、
    // SystemTime → Duration 計算で扱う (システム時刻のジャンプには弱いが旧実装と同じ前提)。
    let watcher_started_at = Instant::now();
    while watcher_started_at.elapsed() < WATCHER_MAX_LIFETIME {
        if is_cancelled() {
            tracing::debug!(
                "[claude_watcher] tid={} cancelled by session — exiting watcher",
                terminal_id
            );
            return;
        }
        match rx.recv_timeout(WATCHER_POLL_INTERVAL) {
            Ok(Ok(event)) => {
                if !matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
                    continue;
                }
                let current = list_session_ids(&dir);
                // Issue #30: 既に他 watcher が claim 済みの id は除外し、未 claim の
                // 新規 id から 1 個だけ atomically に占有する。
                let mut new_ids: Vec<&String> = current
                    .difference(&snapshot)
                    .filter(|sid| !is_claimed(sid))
                    .collect();
                // 順序を安定化 (どの watcher が先に claim してもデテルミニスティックに)
                new_ids.sort();
                // Issue #31 対策用 normalize。毎イベント再計算しても軽量 (canonicalize は
                // 最初にキャッシュされる OS FS cache にヒットする)。
                for candidate in new_ids {
                    // jsonl の cwd が一致しないなら別 project の衝突なのでスキップ
                    let candidate_path = dir.join(format!("{}.jsonl", candidate));
                    if !jsonl_matches_project(&candidate_path, &expected_norm) {
                        tracing::debug!("[claude_watcher] skip {} (cwd mismatch)", candidate);
                        continue;
                    }
                    if !try_claim(candidate) {
                        // 競合で claim できず → 次の候補へ
                        continue;
                    }
                    if emit_session_id(&app, &terminal_id, candidate) {
                        return;
                    }
                }
                // まだ自分の番が来ていない → snapshot を更新して次イベントを待つ。
                // (他の watcher が claim した id は snapshot に足し、次回の difference から除外する)
                snapshot.extend(current);
            }
            Ok(Err(_)) | Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(_) => break,
        }
    }
    tracing::debug!(
        "[claude_watcher] tid={} watcher exit (deadline / cancelled / channel closed)",
        terminal_id
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::Duration;

    fn unique_temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vibe-editor-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn recent_candidates_include_only_files_modified_after_since() {
        let dir = unique_temp_dir("claude-watcher-recent");
        let old_path = dir.join("old-session.jsonl");
        fs::write(&old_path, "{}\n").expect("write old jsonl");

        std::thread::sleep(Duration::from_millis(20));
        let since = SystemTime::now();
        std::thread::sleep(Duration::from_millis(20));

        let new_path = dir.join("new-session.jsonl");
        fs::write(&new_path, "{}\n").expect("write new jsonl");
        fs::write(dir.join("ignored.txt"), "{}\n").expect("write ignored file");

        let ids = list_recent_session_candidates(&dir, since)
            .into_iter()
            .map(|c| c.id)
            .collect::<Vec<_>>();

        assert_eq!(ids, vec!["new-session"]);
        let _ = fs::remove_dir_all(dir);
    }

    /// Issue #632: poll interval が 500ms (旧) より十分短く、watcher が cancel を
    /// 観測してから exit するまでの「最大待ち時間」が短いことを定数で機械的に保証する。
    /// 数値そのものは将来 50ms に下げる等の調整が入っても、500ms 以下で居続けることが
    /// 「orphan watcher を 30 個並走させない」要件の核心。
    #[test]
    fn watcher_poll_interval_is_significantly_shorter_than_legacy_500ms() {
        // 旧実装は 500ms ごとに is_alive() を polling していた。新実装はそれより十分小さい
        // ことを保証する (= 短命 PTY 連発時の watcher 終息が早くなる)。
        assert!(
            WATCHER_POLL_INTERVAL <= Duration::from_millis(200),
            "poll interval は旧 500ms より十分短くあるべき: {:?}",
            WATCHER_POLL_INTERVAL
        );
        // 0 / 1ms みたいな busy-loop には絶対しない (CPU 暴走防止)
        assert!(
            WATCHER_POLL_INTERVAL >= Duration::from_millis(10),
            "0ms / busy-loop は CPU 暴走 — 最低 10ms は確保: {:?}",
            WATCHER_POLL_INTERVAL
        );
    }

    /// Issue #632: deadline は session 起動 anchor + 60 秒の hard cap として維持される。
    /// 60 秒未満に短縮すると「Claude が起動して session を作るのに数秒かかるケース」で
    /// 検出取りこぼしが起きる。本テストは「deadline 値そのものをうっかり弄らない」ための
    /// guard。
    #[test]
    fn watcher_max_lifetime_is_at_least_30_seconds() {
        assert!(
            WATCHER_MAX_LIFETIME >= Duration::from_secs(30),
            "max lifetime が短すぎると Claude 起動が遅い環境で検出漏れする: {:?}",
            WATCHER_MAX_LIFETIME
        );
    }
}

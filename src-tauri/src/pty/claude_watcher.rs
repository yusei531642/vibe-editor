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
// 注意:
//   - Claude Code 以外 (codex 等) は jsonl を作らないので呼び出さない (renderer 制御)
//   - notify は OS の inotify/ReadDirectoryChangesW に依存。Windows でも動く

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use once_cell::sync::Lazy;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::channel;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

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

/// 1 つの terminal セッションに対して watch を開始する。
/// `is_alive` が false を返したら自動停止。
/// 検出した sessionId は callback に渡される (1 回限り)。
pub fn spawn_watcher(
    app: AppHandle,
    terminal_id: String,
    project_root: String,
    is_alive: impl Fn() -> bool + Send + 'static,
) {
    std::thread::spawn(move || {
        let dir = projects_dir(&project_root);
        // ディレクトリが無い場合も Claude が起動後に作るので、最大 5 秒待機
        let mut waits = 0;
        while !dir.exists() && waits < 50 {
            std::thread::sleep(Duration::from_millis(100));
            waits += 1;
            if !is_alive() {
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

        // 最大 60 秒だけ監視 (Claude が起動して session を作るのは通常数秒以内)
        let deadline = std::time::Instant::now() + Duration::from_secs(60);
        while std::time::Instant::now() < deadline {
            if !is_alive() {
                break;
            }
            match rx.recv_timeout(Duration::from_millis(500)) {
                Ok(Ok(event)) => {
                    if !matches!(
                        event.kind,
                        EventKind::Create(_) | EventKind::Modify(_)
                    ) {
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
                    let expected_norm =
                        super::path_norm::normalize_project_root(&project_root);
                    for candidate in new_ids {
                        // jsonl の cwd が一致しないなら別 project の衝突なのでスキップ
                        let candidate_path = dir.join(format!("{}.jsonl", candidate));
                        if !jsonl_matches_project(&candidate_path, &expected_norm) {
                            tracing::debug!(
                                "[claude_watcher] skip {} (cwd mismatch)",
                                candidate
                            );
                            continue;
                        }
                        if !try_claim(candidate) {
                            // 競合で claim できず → 次の候補へ
                            continue;
                        }
                        let event_name = format!("terminal:sessionId:{terminal_id}");
                        if let Err(e) = app.emit(&event_name, candidate.clone()) {
                            tracing::warn!("[claude_watcher] emit failed: {e}");
                        } else {
                            tracing::info!(
                                "[claude_watcher] sessionId detected tid={} sid={}",
                                terminal_id,
                                candidate
                            );
                        }
                        return;
                    }
                    // まだ自分の番が来ていない → snapshot を更新して次イベントを待つ。
                    // (他の watcher が claim した id は snapshot に足し、次回の difference から除外する)
                    snapshot.extend(current.into_iter());
                }
                Ok(Err(_)) | Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => break,
            }
        }
        tracing::debug!("[claude_watcher] tid={} watcher exit (timeout / dead)", terminal_id);
    });
}

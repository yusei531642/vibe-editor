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
/// 戻り値:
///   - Match    : cwd が読めて normalize 一致 → 即 claim 候補
///   - Mismatch : cwd が読めて不一致 / 空文字 → 別 project (今後再評価しない)
///   - Pending  : 16 行以内に cwd フィールドが現れない → 不完全 jsonl の可能性が高い。
///                呼び出し側はこれを snapshot に **追加しない** ことで、追記後の Modify
///                イベントで再評価する。
///
/// 旧実装の Bug:
///   Claude Code 最近版では jsonl 先頭が `last-prompt` / `permission-mode` (cwd なし) で始まる。
///   旧 fail-closed `false` 戻りでは呼び出し側がこれを「Mismatch (= 別プロジェクト)」と
///   同じ扱いにして snapshot に積み、追記後も再評価されず sessionId 検出が永久に失敗していた。
pub enum JsonlCheck {
    Match,
    Mismatch,
    Pending,
}

fn jsonl_matches_project(jsonl_path: &Path, expected_norm: &str) -> JsonlCheck {
    use std::io::{BufRead, BufReader};
    let file = match std::fs::File::open(jsonl_path) {
        Ok(f) => f,
        // open 失敗は今は読めないだけかもしれないので Pending にして再評価する
        Err(_) => return JsonlCheck::Pending,
    };
    let reader = BufReader::new(file);
    // 旧実装は 8 行までだったが、Claude Code の jsonl 先頭メタ行 (last-prompt /
    // permission-mode / file-history-snapshot 等) が増えたため 16 行に拡大する。
    for line in reader.lines().take(16).flatten() {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
            if let Some(c) = v.get("cwd").and_then(|c| c.as_str()) {
                let trimmed = c.trim();
                if trimmed.is_empty() {
                    return JsonlCheck::Mismatch;
                }
                return if super::path_norm::normalize_project_root(trimmed) == expected_norm {
                    JsonlCheck::Match
                } else {
                    JsonlCheck::Mismatch
                };
            }
        }
    }
    // cwd 行が見つからない → まだ書き込み途中の可能性。次の Modify で再評価。
    JsonlCheck::Pending
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

        // Claude Code は起動しただけでは jsonl/sessionId を作らず、初回入力後に作ることがある。
        // 60 秒で諦めると、起動後しばらく待ってから話しかけたセッションが保存されない。
        // PTY が生きている間は見張り続け、閉じられたら自然に終了する。
        while is_alive() {
            match rx.recv_timeout(Duration::from_millis(500)) {
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
                    let expected_norm = super::path_norm::normalize_project_root(&project_root);
                    // Pending (cwd 未書き込み) の id は次の Modify で再評価したいので
                    // snapshot に積まないように分離して保持する。
                    let mut pending_ids: HashSet<String> = HashSet::new();
                    let mut claimed_in_loop = false;
                    for candidate in new_ids {
                        let candidate_path = dir.join(format!("{}.jsonl", candidate));
                        match jsonl_matches_project(&candidate_path, &expected_norm) {
                            JsonlCheck::Pending => {
                                tracing::debug!(
                                    "[claude_watcher] {} cwd not yet written — will retry",
                                    candidate
                                );
                                pending_ids.insert(candidate.clone());
                                continue;
                            }
                            JsonlCheck::Mismatch => {
                                tracing::debug!(
                                    "[claude_watcher] skip {} (cwd mismatch)",
                                    candidate
                                );
                                // snapshot に追加されて再評価から外れる (loop 外で extend)
                                continue;
                            }
                            JsonlCheck::Match => {}
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
                        claimed_in_loop = true;
                        break;
                    }
                    if claimed_in_loop {
                        return;
                    }
                    // まだ自分の番が来ていない → snapshot を更新して次イベントを待つ。
                    // (他 watcher が claim した id や Mismatch 確定の id は snapshot に積む。
                    //  Pending の id は積まずに残し、次の Modify イベントで再評価する。)
                    for id in current {
                        if !pending_ids.contains(&id) {
                            snapshot.insert(id);
                        }
                    }
                }
                Ok(Err(_)) | Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => break,
            }
        }
        tracing::debug!("[claude_watcher] tid={} watcher exit (dead)", terminal_id);
    });
}

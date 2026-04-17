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
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::channel;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// 旧 encodeProjectPath: 非英数を `-` に置換
fn encode_project_path(root: &str) -> String {
    root.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn projects_dir(project_root: &str) -> PathBuf {
    let home = dirs::home_dir().unwrap_or_default();
    home.join(".claude")
        .join("projects")
        .join(encode_project_path(project_root))
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

        let snapshot = list_session_ids(&dir);
        tracing::debug!(
            "[claude_watcher] tid={} dir={} initial={} entries",
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
                    let new_ids: Vec<&String> = current.difference(&snapshot).collect();
                    if let Some(found) = new_ids.first() {
                        let event_name = format!("terminal:sessionId:{terminal_id}");
                        if let Err(e) = app.emit(&event_name, (*found).clone()) {
                            tracing::warn!("[claude_watcher] emit failed: {e}");
                        } else {
                            tracing::info!(
                                "[claude_watcher] sessionId detected tid={} sid={}",
                                terminal_id,
                                found
                            );
                        }
                        return;
                    }
                }
                Ok(Err(_)) | Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => break,
            }
        }
        tracing::debug!("[claude_watcher] tid={} watcher exit (timeout / dead)", terminal_id);
    });
}

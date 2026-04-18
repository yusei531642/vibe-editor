// Issue #66: project root のファイル変更を監視し、renderer に `project:files-changed`
// イベントで通知する。renderer 側は git status / file tree をリフレッシュできる。
//
// 設計:
//   - app_set_project_root で project_root が変わるたびに watcher を再起動
//   - notify crate の RecommendedWatcher で project_root/ を recursive 監視
//   - イベントは 300ms debounce して「連続変更のうち最後の 1 回だけ」emit
//   - .git/**, node_modules/**, target/**, dist/** は除外 (高頻度変更で UI が詰まる)

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use once_cell::sync::Lazy;
use std::path::{Path, PathBuf};
use std::sync::mpsc::channel;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// 監視除外ディレクトリ名 (basename 一致)
const IGNORED_DIRS: &[&str] = &[".git", "node_modules", "target", "dist", ".next", "out"];

fn path_is_ignored(path: &Path, root: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(root) else {
        return false;
    };
    rel.components().any(|c| {
        let comp = c.as_os_str().to_string_lossy();
        IGNORED_DIRS.contains(&comp.as_ref())
    })
}

/// 現在動いている watcher のスレッドを停止させるためのフラグ
static ACTIVE_WATCHER_ROOT: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));

/// `root` 配下を監視開始する。既に別 root で動いていたら停止する。
pub fn start_for_root(app: AppHandle, root: String) {
    // 同じ root なら no-op
    {
        let guard = ACTIVE_WATCHER_ROOT.lock().ok();
        if let Some(guard) = guard {
            if guard.as_deref() == Some(root.as_str()) {
                return;
            }
        }
    }
    // ACTIVE_WATCHER_ROOT を更新 (旧 watcher は `*_ROOT != my_root` 判定で自分で stop する)
    if let Ok(mut g) = ACTIVE_WATCHER_ROOT.lock() {
        *g = Some(root.clone());
    }

    let my_root = root.clone();
    std::thread::spawn(move || {
        let root_path = PathBuf::from(&my_root);
        if !root_path.exists() {
            tracing::debug!("[fs_watch] root does not exist: {my_root}");
            return;
        }

        let (tx, rx) = channel::<notify::Result<Event>>();
        let mut watcher: RecommendedWatcher = match Watcher::new(
            move |res| {
                let _ = tx.send(res);
            },
            notify::Config::default().with_poll_interval(Duration::from_secs(2)),
        ) {
            Ok(w) => w,
            Err(e) => {
                tracing::warn!("[fs_watch] watcher init failed: {e}");
                return;
            }
        };
        if let Err(e) = watcher.watch(&root_path, RecursiveMode::Recursive) {
            tracing::warn!("[fs_watch] watch failed: {e}");
            return;
        }
        tracing::info!("[fs_watch] started for {my_root}");

        let mut last_emit = Instant::now() - Duration::from_secs(1);
        const DEBOUNCE: Duration = Duration::from_millis(300);

        loop {
            // アクティブ root が自分でなくなったら終了
            if ACTIVE_WATCHER_ROOT.lock().ok().and_then(|g| g.clone()).as_deref()
                != Some(my_root.as_str())
            {
                tracing::debug!("[fs_watch] stopping watcher for {my_root}");
                break;
            }
            let Ok(res) = rx.recv_timeout(Duration::from_millis(500)) else {
                continue;
            };
            let Ok(event) = res else { continue };
            // Create / Modify / Remove 以外は無視
            if !matches!(
                event.kind,
                EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
            ) {
                continue;
            }
            // 除外ディレクトリのみのイベントはスキップ
            let all_ignored = event
                .paths
                .iter()
                .all(|p| path_is_ignored(p, &root_path));
            if all_ignored {
                continue;
            }
            // debounce: 300ms 以内の連続イベントは吸収
            let now = Instant::now();
            if now.duration_since(last_emit) < DEBOUNCE {
                continue;
            }
            last_emit = now;
            if let Err(e) = app.emit("project:files-changed", &my_root) {
                tracing::warn!("[fs_watch] emit failed: {e}");
            }
        }
    });
}

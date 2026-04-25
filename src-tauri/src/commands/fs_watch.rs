// Issue #66: project root のファイル変更を監視し、renderer に `project:files-changed`
// イベントで通知する。renderer 側は git status / file tree をリフレッシュできる。
//
// 設計:
//   - app_set_project_root で project_root が変わるたびに watcher を再起動
//   - notify crate の RecommendedWatcher で project_root/ を recursive 監視
//   - イベントは 300ms trailing debounce: 最後のイベント着信から 300ms 経ってから emit
//     (Issue #105: 旧実装は leading debounce で最初のイベントしか拾えず、保存処理の
//      最後の状態 (rename 後など) を取り逃すバグがあった)
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

        const DEBOUNCE: Duration = Duration::from_millis(300);
        // Issue #105: trailing debounce 用の pending state。
        //   - イベントが届くたびに last_event_at を更新
        //   - 次のループで last_event_at から DEBOUNCE 経過していたら emit
        //   - DEBOUNCE 内に新しいイベントが来たら待機継続 → 最後の状態だけ emit される
        let mut pending: bool = false;
        let mut last_event_at: Instant = Instant::now();

        loop {
            // アクティブ root が自分でなくなったら終了
            if ACTIVE_WATCHER_ROOT.lock().ok().and_then(|g| g.clone()).as_deref()
                != Some(my_root.as_str())
            {
                tracing::debug!("[fs_watch] stopping watcher for {my_root}");
                break;
            }

            // pending 中は短い timeout で再ループして trailing emit を判定する。
            // pending 無しなら長めに block し続けて CPU を食わない。
            let recv_timeout = if pending {
                Duration::from_millis(50)
            } else {
                Duration::from_millis(500)
            };

            match rx.recv_timeout(recv_timeout) {
                Ok(Ok(event)) => {
                    // Create / Modify / Remove 以外は無視
                    if !matches!(
                        event.kind,
                        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
                    ) {
                        // pending を維持して次ループへ
                    } else {
                        // 除外ディレクトリのみのイベントはスキップ
                        let all_ignored = event
                            .paths
                            .iter()
                            .all(|p| path_is_ignored(p, &root_path));
                        if !all_ignored {
                            pending = true;
                            last_event_at = Instant::now();
                        }
                    }
                }
                Ok(Err(_)) => {
                    // notify からのエラーは無視 (pending は維持)
                }
                Err(_) => {
                    // timeout: 何もしない (下の trailing 判定に進む)
                }
            }

            // trailing debounce: 最後のイベントから DEBOUNCE 経過していたら emit
            if pending && last_event_at.elapsed() >= DEBOUNCE {
                pending = false;
                if let Err(e) = app.emit("project:files-changed", &my_root) {
                    tracing::warn!("[fs_watch] emit failed: {e}");
                }
            }
        }
    });
}

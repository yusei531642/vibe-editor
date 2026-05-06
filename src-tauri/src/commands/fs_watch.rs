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

/// Issue #204:
/// renderer 由来の root を無条件に再帰監視しない。
/// ユーザーの「プロジェクト」として自然なディレクトリだけを許可し、
/// ルートドライブ / ホーム直下 / 明らかなシステム領域は拒否する。
fn is_safe_watch_root(root: &Path) -> bool {
    let Ok(canon) = root.canonicalize() else {
        return false;
    };
    let Ok(meta) = std::fs::metadata(&canon) else {
        return false;
    };
    if !meta.is_dir() {
        return false;
    }

    if let Some(home) = dirs::home_dir() {
        let home_canon = home.canonicalize().unwrap_or(home);
        if canon == home_canon {
            return false;
        }
    }

    #[cfg(windows)]
    {
        let lower = canon.to_string_lossy().to_lowercase();
        if lower.len() <= 3 && lower.ends_with(":\\") {
            return false;
        }
        if lower == "c:\\" {
            return false;
        }
        for prefix in [
            "c:\\windows",
            "c:\\program files",
            "c:\\program files (x86)",
            "c:\\programdata",
        ] {
            if lower.starts_with(prefix) {
                return false;
            }
        }
    }

    #[cfg(unix)]
    {
        if canon == Path::new("/") {
            return false;
        }
        let lower = canon.to_string_lossy();
        for prefix in ["/etc", "/sys", "/proc", "/dev", "/usr", "/bin", "/sbin", "/boot"] {
            if lower.starts_with(prefix) {
                return false;
            }
        }
    }

    true
}

/// 現在動いている watcher を識別する世代カウンタ。
/// Issue #146: 旧実装は ROOT 文字列の一致だけで「自分が現役か」を判定していたため、
/// 同じ root を 2 回 start すると watcher が並走してしまう余地があり、また
/// 切替直後に旧 watcher が emit するタイミングを潰せなかった。
/// 世代を毎回 +1 して、ループ内では `current_generation() == my_generation` で照合する。
static ACTIVE_WATCHER_GEN: Lazy<Mutex<(u64, Option<String>)>> = Lazy::new(|| Mutex::new((0, None)));

fn current_active() -> (u64, Option<String>) {
    ACTIVE_WATCHER_GEN.lock().ok().map(|g| g.clone()).unwrap_or((0, None))
}

/// `root` 配下を監視開始する。既に別 root で動いていたら停止する。
pub fn start_for_root(app: AppHandle, root: String) {
    // Issue #171: 「同 root なら no-op」判定と generation 更新の lock を分けると
    // TOCTOU で同 root に並行 start_for_root が両方 spawn する race があった。
    // 1 つの critical section にまとめ、no-op 判定 → generation 更新 → spawn 引数生成までを
    // ロック保持中に行う。
    let my_generation = {
        let Ok(mut g) = ACTIVE_WATCHER_GEN.lock() else {
            return;
        };
        if g.1.as_deref() == Some(root.as_str()) {
            return; // 同 root 同 generation が既に動いているので no-op
        }
        g.0 = g.0.wrapping_add(1);
        g.1 = Some(root.clone());
        g.0
    };

    let my_root = root;
    std::thread::spawn(move || {
        let root_path = PathBuf::from(&my_root);
        if !root_path.exists() {
            tracing::debug!("[fs_watch] root does not exist: {my_root}");
            return;
        }
        if !is_safe_watch_root(&root_path) {
            tracing::warn!("[fs_watch] refusing unsafe watch root: {my_root}");
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
            // アクティブ世代が自分でなくなったら即終了 (Watcher を drop してカーネル枠を解放)
            let (active_gen, _) = current_active();
            if active_gen != my_generation {
                tracing::debug!("[fs_watch] stopping watcher for {my_root} (gen={my_generation})");
                break;
            }

            // pending 中は短い timeout で再ループして trailing emit を判定する。
            // pending 無しは中程度の timeout (500ms → 200ms) で active 世代切替への応答性を上げる。
            let recv_timeout = if pending {
                Duration::from_millis(50)
            } else {
                Duration::from_millis(200)
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
                // Issue #146: emit 直前に再度 active 世代を確認。debounce 待ちの 300ms 中に
                // root が切替えられた場合は旧 root のイベントを誤発火させない。
                let (active_gen, _) = current_active();
                if active_gen != my_generation {
                    tracing::debug!(
                        "[fs_watch] suppressing stale emit for {my_root} (gen={my_generation})"
                    );
                    break;
                }
                if let Err(e) = app.emit("project:files-changed", &my_root) {
                    tracing::warn!("[fs_watch] emit failed: {e}");
                }
            }
        }
        // Watcher は drop で notify の OS 側 watch を unregister する。
    });
}

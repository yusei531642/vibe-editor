// Issue #66: project root のファイル変更を監視し、renderer に `project:files-changed`
// イベントで通知する。renderer 側は git status / file tree をリフレッシュできる。
//
// 設計:
//   - native project authority がproject_rootを切り替えるたびに watcher を再起動
//   - notify crate の RecommendedWatcher で project_root/ 配下を手動で非再帰監視
//   - イベントは 300ms trailing debounce: 最後のイベント着信から 300ms 経ってから emit
//     (Issue #105: 旧実装は leading debounce で最初のイベントしか拾えず、保存処理の
//      最後の状態 (rename 後など) を取り逃すバグがあった)
//   - .git/**, node_modules/**, target/**, dist/** は除外 (高頻度変更で UI が詰まる)

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use once_cell::sync::Lazy;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::sync_channel;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;
use tauri::{AppHandle, Emitter};

/// 監視除外ディレクトリ名 (basename 一致)
const IGNORED_DIRS: &[&str] = &[".git", "node_modules", "target", "dist", ".next", "out"];
const WATCH_EVENT_CHANNEL_CAPACITY: usize = 1024;

fn file_name_is_ignored(name: &OsStr) -> bool {
    IGNORED_DIRS
        .iter()
        .any(|ignored| name == OsStr::new(ignored))
}

fn path_is_ignored(path: &Path, root: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(root) else {
        return false;
    };
    rel.components()
        .any(|c| file_name_is_ignored(c.as_os_str()))
}

fn watch_dir_tree(watcher: &mut RecommendedWatcher, root: &Path) -> notify::Result<usize> {
    let mut watched = 0usize;
    let mut stack = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        if dir != root && path_is_ignored(&dir, root) {
            continue;
        }

        match watcher.watch(&dir, RecursiveMode::NonRecursive) {
            Ok(()) => watched += 1,
            Err(e) if dir == root => return Err(e),
            Err(e) => {
                tracing::warn!("[fs_watch] failed to watch subdir {dir:?}; continuing: {e}");
                continue;
            }
        }

        let Ok(entries) = fs::read_dir(&dir) else {
            tracing::debug!("[fs_watch] cannot read dir while registering watch: {dir:?}");
            continue;
        };

        for entry in entries.flatten() {
            if file_name_is_ignored(&entry.file_name()) {
                continue;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                stack.push(entry.path());
            }
        }
    }

    Ok(watched)
}

fn watch_created_dirs(watcher: &mut RecommendedWatcher, event: &Event, root: &Path) {
    if !matches!(event.kind, EventKind::Create(_)) {
        return;
    }

    for path in &event.paths {
        if path_is_ignored(path, root) {
            continue;
        }
        let Ok(file_type) = fs::symlink_metadata(path).map(|m| m.file_type()) else {
            continue;
        };
        if !file_type.is_dir() || file_type.is_symlink() {
            continue;
        }
        match watch_dir_tree(watcher, path) {
            Ok(count) => tracing::debug!("[fs_watch] added {count} watches for new dir: {path:?}"),
            Err(e) => tracing::warn!("[fs_watch] failed to watch new dir {path:?}: {e}"),
        }
    }
}

/// Issue #204:
/// renderer 由来の root を無条件に再帰監視しない。
/// ユーザーの「プロジェクト」として自然なディレクトリだけを許可し、
/// ルートドライブ / ホーム直下 / 明らかなシステム領域は拒否する。
///
/// Issue #1193: native project authorityも同水準の検証を行うため `pub(crate)` で公開する。
/// 「fs_watch 用」と「native project activation 用」で同じ judgement (canonicalize / system
/// 領域 denylist / home 直下拒否) を共有することで、TOCTOU で project_root が system 領域に
/// 切り替わって後続 IPC (git_*, fs_watch::start_for_root, file 読み書き) が信頼できない
/// 場所で発火するのを防ぐ defense-in-depth とする。
pub(crate) fn is_safe_watch_root(root: &Path) -> bool {
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

    // Issue #1193: private authority ledger / settings / TeamHub state を含む
    // `~/.vibe-editor` 自体（またはその祖先・子孫）をprojectにすると、認可済みfiles IPCから
    // ledgerを書き換えてnative approvalを偽造できる。通常projectはsiblingなので影響しない。
    if let Ok(private_root) = crate::util::config_paths::vibe_root().canonicalize() {
        if canon.starts_with(&private_root) || private_root.starts_with(&canon) {
            return false;
        }
    }

    #[cfg(windows)]
    {
        // Issue #963: `Path::canonicalize` は Windows で `\\?\C:\...` の verbatim prefix を
        // 付ける。素の `to_string_lossy` だと denylist の `c:\windows` 前方一致が
        // `\\?\c:\windows` に対して常に false になり、C:\Windows / ドライブルートが
        // 「safe」と誤判定されていた (= #639 の project_root setter ガードも無効化)。
        // verbatim prefix (`\\?\` / `\\?\UNC\`) を剥がしてから比較する。
        let raw = canon.to_string_lossy();
        let stripped = raw
            .strip_prefix(r"\\?\UNC\")
            .map(|rest| format!(r"\\{rest}"))
            .or_else(|| raw.strip_prefix(r"\\?\").map(str::to_string))
            .unwrap_or_else(|| raw.to_string());
        let lower = stripped.to_lowercase();
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
        for prefix in [
            "/etc",
            "/private/etc",
            "/sys",
            "/proc",
            "/dev",
            "/usr",
            "/bin",
            "/sbin",
            "/boot",
        ] {
            if canon.starts_with(prefix) {
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
    ACTIVE_WATCHER_GEN
        .lock()
        .ok()
        .map(|g| g.clone())
        .unwrap_or((0, None))
}

fn claim_active_for_root(root: &str) -> Option<u64> {
    let Ok(mut g) = ACTIVE_WATCHER_GEN.lock() else {
        return None;
    };
    if g.1.as_deref() == Some(root) {
        return None;
    }
    g.0 = g.0.wrapping_add(1);
    g.1 = Some(root.to_string());
    Some(g.0)
}

fn rollback_active_if_current(generation: u64, root: &str) {
    let Ok(mut g) = ACTIVE_WATCHER_GEN.lock() else {
        return;
    };
    if g.0 == generation && g.1.as_deref() == Some(root) {
        g.1 = None;
    }
}

/// 現在の watcher を無効化する。root を空文字へ切り替えるだけでは旧 watcher が残るため、
/// project authority を clear するときは必ず generation を進めて thread を終了させる。
pub fn stop_active_watcher() {
    let Ok(mut g) = ACTIVE_WATCHER_GEN.lock() else {
        return;
    };
    g.0 = g.0.wrapping_add(1);
    g.1 = None;
}

/// `root` 配下を監視開始する。既に別 root で動いていたら停止する。
pub fn start_for_root(app: AppHandle, root: String) {
    // Issue #171: 「同 root なら no-op」判定と generation 更新の lock を分けると
    // TOCTOU で同 root に並行 start_for_root が両方 spawn する race があった。
    // 1 つの critical section にまとめ、no-op 判定 → generation 更新 → spawn 引数生成までを
    // ロック保持中に行う。
    let Some(my_generation) = claim_active_for_root(&root) else {
        return; // 同 root 同 generation が既に動いているので no-op
    };

    let supervisor = app
        .state::<crate::state::AppState>()
        .task_supervisor
        .clone();
    let cancel_token = supervisor.cancellation_token();
    let my_root = root;
    let my_root_for_rollback = my_root.clone();
    let spawn_result = supervisor.spawn_thread("fs-watch", cancel_token, move |cancel_token| {
        let root_path = PathBuf::from(&my_root);
        if !root_path.exists() {
            tracing::debug!("[fs_watch] root does not exist: {my_root}");
            rollback_active_if_current(my_generation, &my_root);
            return;
        }
        if !is_safe_watch_root(&root_path) {
            tracing::warn!("[fs_watch] refusing unsafe watch root: {my_root}");
            rollback_active_if_current(my_generation, &my_root);
            return;
        }

        let (tx, rx) = sync_channel::<notify::Result<Event>>(WATCH_EVENT_CHANNEL_CAPACITY);
        let mut watcher: RecommendedWatcher = match Watcher::new(
            move |res| {
                let _ = tx.try_send(res);
            },
            notify::Config::default().with_poll_interval(Duration::from_secs(2)),
        ) {
            Ok(w) => w,
            Err(e) => {
                tracing::warn!("[fs_watch] watcher init failed: {e}");
                rollback_active_if_current(my_generation, &my_root);
                return;
            }
        };
        match watch_dir_tree(&mut watcher, &root_path) {
            Ok(count) => tracing::info!("[fs_watch] started for {my_root} ({count} dirs watched)"),
            Err(e) => {
                tracing::warn!("[fs_watch] watch failed: {e}");
                rollback_active_if_current(my_generation, &my_root);
                return;
            }
        }

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
            if cancel_token.is_cancelled() || active_gen != my_generation {
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
                        watch_created_dirs(&mut watcher, &event, &root_path);
                        // 除外ディレクトリのみのイベントはスキップ
                        let all_ignored =
                            event.paths.iter().all(|p| path_is_ignored(p, &root_path));
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
                if cancel_token.is_cancelled() || active_gen != my_generation {
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
    if let Err(e) = spawn_result {
        tracing::warn!("[fs_watch] failed to spawn watcher thread: {e}");
        rollback_active_if_current(my_generation, &my_root_for_rollback);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        claim_active_for_root, current_active, file_name_is_ignored, is_safe_watch_root,
        path_is_ignored, rollback_active_if_current, stop_active_watcher, ACTIVE_WATCHER_GEN,
    };
    use once_cell::sync::Lazy;
    use std::ffi::OsStr;

    /// Issue #963: canonicalize の verbatim prefix (`\\?\C:\...`) で system 領域 denylist が
    /// 素通りしていた回帰を固定する。system ディレクトリは safe と判定してはならない。
    #[test]
    fn system_directories_are_not_safe_watch_roots() {
        #[cfg(windows)]
        for sys in ["C:\\Windows", "C:\\Program Files", "C:\\"] {
            let p = std::path::Path::new(sys);
            if p.exists() {
                assert!(
                    !is_safe_watch_root(p),
                    "{sys} must be rejected as an unsafe watch root"
                );
            }
        }
        #[cfg(unix)]
        for sys in ["/etc", "/usr", "/"] {
            let p = std::path::Path::new(sys);
            if p.exists() {
                assert!(
                    !is_safe_watch_root(p),
                    "{sys} must be rejected as an unsafe watch root"
                );
            }
        }
    }

    /// 通常のプロジェクトディレクトリ (tempdir) は safe と判定される。
    #[test]
    fn ordinary_project_dir_is_safe_watch_root() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("my-project");
        std::fs::create_dir(&sub).unwrap();
        assert!(is_safe_watch_root(&sub));
    }
    use std::path::Path;
    use std::sync::Mutex;

    static ACTIVE_WATCHER_TEST_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

    fn reset_active_for_test() {
        let mut active = ACTIVE_WATCHER_GEN.lock().unwrap();
        *active = (0, None);
    }

    #[test]
    fn ignores_configured_heavy_directories() {
        assert!(file_name_is_ignored(OsStr::new(".git")));
        assert!(file_name_is_ignored(OsStr::new("node_modules")));
        assert!(file_name_is_ignored(OsStr::new("target")));
        assert!(!file_name_is_ignored(OsStr::new("src")));
    }

    #[test]
    fn detects_ignored_components_without_string_allocation() {
        let root = Path::new("project");
        assert!(path_is_ignored(
            Path::new("project/node_modules/pkg/index.js"),
            root
        ));
        assert!(path_is_ignored(
            Path::new("project/src-tauri/target/debug/app"),
            root
        ));
        assert!(!path_is_ignored(Path::new("project/src/main.rs"), root));
    }

    #[test]
    fn rollback_allows_same_root_to_be_retried_after_start_failure() {
        let _guard = ACTIVE_WATCHER_TEST_LOCK.lock().unwrap();
        reset_active_for_test();

        let root = "F:/tmp/vibe-editor-watch-root";
        let generation = claim_active_for_root(root).expect("first claim should start");
        assert!(claim_active_for_root(root).is_none());

        rollback_active_if_current(generation, root);

        let retried = claim_active_for_root(root);
        assert!(
            retried.is_some(),
            "same root must be retryable after rollback"
        );
        reset_active_for_test();
    }

    #[test]
    fn stale_rollback_does_not_clear_newer_watcher_generation() {
        let _guard = ACTIVE_WATCHER_TEST_LOCK.lock().unwrap();
        reset_active_for_test();

        let old_root = "F:/tmp/vibe-editor-watch-old";
        let new_root = "F:/tmp/vibe-editor-watch-new";
        let old_generation = claim_active_for_root(old_root).unwrap();
        let new_generation = claim_active_for_root(new_root).unwrap();

        rollback_active_if_current(old_generation, old_root);

        assert_eq!(
            current_active(),
            (new_generation, Some(new_root.to_string()))
        );
        reset_active_for_test();
    }

    #[test]
    fn stopping_active_watcher_invalidates_the_current_generation() {
        let _guard = ACTIVE_WATCHER_TEST_LOCK.lock().unwrap();
        reset_active_for_test();
        let generation = claim_active_for_root("/tmp/vibe-editor-watch-root").unwrap();
        stop_active_watcher();
        let (current_generation, root) = current_active();
        assert!(current_generation > generation);
        assert!(root.is_none());
        reset_active_for_test();
    }
}

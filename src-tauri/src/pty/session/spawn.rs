//! Issue #738: PTY セッションの spawn ロジックと `SpawnOptions`。
//!
//! 旧 `session.rs` の `SpawnOptions` / `PreparedSpawnCommand` / `prepare_spawn_command` /
//! `resolve_spawn_command` / `spawn_session` / `resolve_valid_cwd` /
//! `resolve_terminal_command_path_for_check*` / spawn メトリクスヘルパ /
//! `maybe_inject_windows_utf8_init` を切り出したもの。
//!
//! spawn/inject/exit の挙動・Windows パス解決の委譲先・ログ出力フォーマットは
//! 一切変えていない。Windows 専用のパス解決は `super::windows_resolve` に分離した。

use crate::pty::batcher::{spawn_batcher, PtyOutputObserver};
use crate::pty::scrollback::{new_scrollback, WriteBudget};
use crate::{commands::terminal::command_validation, util::log_redact::redact_home};
use anyhow::{anyhow, Result};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;

use super::handle::{SessionHandle, TerminalExitInfo};

#[derive(Clone)]
pub struct SpawnOptions {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub is_codex: bool,
    pub cols: u16,
    pub rows: u16,
    pub env: HashMap<String, String>,
    pub agent_id: Option<String>,
    /// Issue #271: HMR 経路で同じ React mount identity を共有する論理キー。
    /// renderer 側の `TerminalCreateOptions.sessionKey` と一致する。
    pub session_key: Option<String>,
    pub team_id: Option<String>,
    pub role: Option<String>,
}

/// `cwd` の検証 (旧 resolveValidCwd と同等)。
/// 無効なら fallback → カレントディレクトリ。warning メッセージも返す。
pub fn resolve_valid_cwd(requested: &str, fallback: Option<&str>) -> (String, Option<String>) {
    let is_dir = |p: &str| !p.is_empty() && Path::new(p).is_dir();
    if is_dir(requested) {
        return (requested.to_string(), None);
    }
    if let Some(fb) = fallback {
        if is_dir(fb) {
            return (
                fb.to_string(),
                Some(format!(
                    "指定された作業ディレクトリが無効です: {} → {} で起動します",
                    if requested.is_empty() {
                        "(未設定)"
                    } else {
                        requested
                    },
                    fb
                )),
            );
        }
    }
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| ".".to_string());
    (
        cwd.clone(),
        Some(format!(
            "作業ディレクトリが無効です: {} → プロセス既定の {} で起動します",
            if requested.is_empty() {
                "(未設定)"
            } else {
                requested
            },
            cwd
        )),
    )
}

#[derive(Debug, Clone)]
pub(crate) struct PreparedSpawnCommand {
    pub(crate) requested_command: String,
    pub(crate) resolved_command: String,
    pub(crate) program: String,
    pub(crate) args: Vec<String>,
    pub(crate) path_entries: usize,
    pub(crate) pathext_present: bool,
}

pub(crate) fn prepare_spawn_command(opts: &SpawnOptions) -> Result<PreparedSpawnCommand> {
    let (command, args) = command_validation::normalize_terminal_command(
        Some(opts.command.clone()),
        Some(opts.args.clone()),
    );
    if !command_validation::is_allowed_terminal_command(&command) {
        return Err(anyhow!(
            "command is not allowed at spawn boundary: {command}"
        ));
    }
    if let Some(reason) = command_validation::reject_immediate_exec_args(&command, &args) {
        return Err(anyhow!("{reason}"));
    }
    let sanctioned_flags = command_validation::settings_sanctioned_danger_flags();
    if let Some(reason) = command_validation::reject_danger_flags(&args, &sanctioned_flags) {
        return Err(anyhow!("{reason}"));
    }
    resolve_spawn_command(&command, args, &opts.env)
}

/// 環境変数 map から大文字小文字を無視して値を引く。map に無ければプロセス env に
/// フォールバックし、空白のみの値は無視する。
pub(super) fn env_value(env: &HashMap<String, String>, key: &str) -> Option<String> {
    env.iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(key))
        .map(|(_, v)| v.clone())
        .or_else(|| std::env::var(key).ok())
        .filter(|v| !v.trim().is_empty())
}

pub(crate) fn resolve_terminal_command_path_for_check(command: &str) -> Result<PathBuf> {
    resolve_terminal_command_path_for_check_with_env(command, &HashMap::new())
}

pub(crate) fn resolve_terminal_command_path_for_check_with_env(
    command: &str,
    env: &HashMap<String, String>,
) -> Result<PathBuf> {
    #[cfg(windows)]
    {
        use super::windows_resolve::{
            resolve_windows_command_path, windows_pathext, windows_search_dirs,
        };
        let pathext_raw = env_value(env, "PATHEXT");
        let pathext = windows_pathext(pathext_raw.as_deref());
        let search_dirs = windows_search_dirs(env);
        resolve_windows_command_path(command, &search_dirs, &pathext)
    }
    #[cfg(not(windows))]
    {
        let _ = env;
        which::which(command).map_err(Into::into)
    }
}

#[cfg(not(windows))]
fn count_path_entries(path: Option<&str>) -> usize {
    path.map(std::env::split_paths)
        .map(|paths| paths.count())
        .unwrap_or(0)
}

#[cfg(not(windows))]
fn resolve_spawn_command(
    command: &str,
    args: Vec<String>,
    env: &HashMap<String, String>,
) -> Result<PreparedSpawnCommand> {
    let resolved_command = which::which(command)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| command.to_string());
    Ok(PreparedSpawnCommand {
        requested_command: command.to_string(),
        resolved_command: resolved_command.clone(),
        program: resolved_command,
        args,
        path_entries: count_path_entries(env_value(env, "PATH").as_deref()),
        pathext_present: false,
    })
}

#[cfg(windows)]
fn resolve_spawn_command(
    command: &str,
    args: Vec<String>,
    env: &HashMap<String, String>,
) -> Result<PreparedSpawnCommand> {
    super::windows_resolve::resolve_windows_spawn_command(command, args, env)
}

/// Issue #579: spawn ログ用に「漏洩しない短い command ラベル」を作る。
///
/// resolved_command はフルパス (例: `C:\Users\foo\AppData\Roaming\npm\claude.cmd`) を
/// 持ちうるので、basename だけ取り出してさらに `redact_home` を通す。`Path::file_name`
/// は Unix 上で Windows 区切り `\` を解釈しないため、cross-platform に動かすには
/// 両方の区切りで rsplit する。
pub(crate) fn build_cmd_label(prepared: &PreparedSpawnCommand) -> String {
    let basename = prepared
        .resolved_command
        .rsplit(|c: char| c == '/' || c == '\\')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(prepared.requested_command.as_str())
        .to_string();
    redact_home(&basename)
}

pub(crate) fn engine_label(is_codex: bool) -> &'static str {
    if is_codex {
        "codex"
    } else {
        "claude"
    }
}

pub(crate) fn platform_label() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "other"
    }
}

/// Issue #579: PTY spawn の所要時間 + 結果を tracing で記録する。
/// 集計は `target=pty` + メッセージ `[pty] spawn ok` / `[pty] spawn failed` で grep する想定。
/// 詳細は `tasks/issue-579/notes.md` を参照。
pub(crate) fn log_spawn_outcome(
    cmd_label: &str,
    engine: &str,
    platform: &str,
    elapsed_ms: u64,
    error: Option<&str>,
) {
    match error {
        None => tracing::info!(
            target: "pty",
            command = %cmd_label,
            engine = %engine,
            platform = %platform,
            elapsed_ms = elapsed_ms,
            "[pty] spawn ok"
        ),
        Some(err) => tracing::warn!(
            target: "pty",
            command = %cmd_label,
            engine = %engine,
            platform = %platform,
            elapsed_ms = elapsed_ms,
            error = %err,
            "[pty] spawn failed"
        ),
    }
}

pub fn spawn_session(
    app: AppHandle,
    id: String,
    opts: SpawnOptions,
    registry: std::sync::Arc<crate::pty::SessionRegistry>,
) -> Result<SessionHandle> {
    let prepared_command = prepare_spawn_command(&opts)?;
    tracing::info!(
        "[pty] spawn command requested={} resolved={} launcher={} args.len={} path_entries={} pathext_present={}",
        redact_home(&prepared_command.requested_command),
        redact_home(&prepared_command.resolved_command),
        redact_home(&prepared_command.program),
        prepared_command.args.len(),
        prepared_command.path_entries,
        prepared_command.pathext_present
    );

    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: opts.rows.max(5),
        cols: opts.cols.max(20),
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let mut cmd = CommandBuilder::new(&prepared_command.program);
    for a in &prepared_command.args {
        cmd.arg(a);
    }
    cmd.cwd(&opts.cwd);
    for (k, v) in std::env::vars() {
        if !super::env_allowlist::should_inherit_env(&k) {
            continue;
        }
        cmd.env(k, v);
    }
    for (k, v) in &opts.env {
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    // Issue #579: PTY spawn 所要時間を計測してログに出す。
    // Windows ConPTY + cmd.exe + npm shim 経由の起動コストの p50/p95 を取るのが目的。
    // 失敗パスでも elapsed_ms を残すため `?` ではなく match で分岐する。
    let cmd_label = build_cmd_label(&prepared_command);
    let engine = engine_label(opts.is_codex);
    let platform = platform_label();
    let started = Instant::now();
    let spawn_result = pair.slave.spawn_command(cmd);
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let mut child = match spawn_result {
        Ok(child) => {
            log_spawn_outcome(&cmd_label, engine, platform, elapsed_ms, None);
            child
        }
        Err(err) => {
            let err_string = err.to_string();
            log_spawn_outcome(&cmd_label, engine, platform, elapsed_ms, Some(&err_string));
            return Err(err.into());
        }
    };
    drop(pair.slave);

    let killer = child.clone_killer();

    // reader thread (blocking IO -> mpsc)
    let mut reader = pair.master.try_clone_reader()?;
    let mut writer = pair.master.take_writer()?;

    // Issue #618: Windows ConPTY で cmd.exe / PowerShell を起動する場合、最初に
    // `chcp 65001` 等を inject してシェル出力を UTF-8 に強制する。これをしないと
    // 既定の OEM コードページ (CP932 / ja-JP) で動くシェルが書き出すバイト列を
    // batcher が `String::from_utf8_lossy` でそのまま UTF-8 として解釈してしまい、
    // `dir` の漢字ファイル名 / `python -c "print('日本語')"` の出力が全 U+FFFD に
    // 化ける (`#120` で files 経路に入れた CP932 デコードは PTY には届いていない)。
    //
    // inject 失敗は致命的ではない (子プロセス側の stdin が EOF / 既に閉じている等):
    // tracing::warn! でログだけ残して spawn は続行する。
    if cfg!(windows) {
        let force_utf8 = command_validation::settings_terminal_force_utf8();
        match maybe_inject_windows_utf8_init(&mut *writer, &opts.command, force_utf8) {
            Ok(Some(injected)) => tracing::info!(
                "[pty] Windows UTF-8 init command injected (command={}, len={})",
                opts.command,
                injected.len()
            ),
            Ok(None) => {} // not applicable / disabled — no-op
            Err(e) => tracing::warn!(
                "[pty] Windows UTF-8 init command write failed (command={}): {}",
                opts.command,
                e
            ),
        }
    }

    let data_event = format!("terminal:data:{id}");
    let exit_event = format!("terminal:exit:{id}");

    // Issue #53: bounded channel で reader → batcher に backpressure をかける。
    //   reader (std::thread) は `blocking_send` でチャネル満杯時に待機 → OS 側で PTY
    //   への入力が詰まれば子プロセスが書き込み待ちに入るので、メモリ無限膨張を防げる。
    //
    // チャンクサイズは 16 KiB。旧 8 KiB 比で大量出力時 (cargo build 等) の syscall /
    // Vec allocation / channel send 頻度が約半分になる。read() は OS が用意した
    // 即時バイト数を返すブロッキング読み出しなので、対話的な小入力では従来通り少バイト
    // しか allocate されない (latency 影響なし)。最大 backpressure は
    // 16 KiB * PTY_CHANNEL_CAPACITY ≒ 4 MiB。
    let (tx, rx) = mpsc::channel::<Vec<u8>>(crate::pty::batcher::PTY_CHANNEL_CAPACITY);
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    // blocking_send: async runtime 外でも動く tokio API
                    if tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Issue #285 follow-up: scrollback リングバッファ。batcher と SessionHandle で共有。
    let scrollback = new_scrollback();

    // Issue #524: agent カードに紐付く PTY のみ、出力 batch flush ごとに TeamHub の
    // `member_diagnostics[agent_id].last_pty_output_at` を update する observer を渡す。
    // ターミナルタブ等の agent_id 無し PTY では None で no-op。
    //
    // closure 内 dedup: 1 秒間隔でしか hub.state lock を取らない。flush は最短 16ms 間隔
    // (FLUSH_INTERVAL_MS) で起こり得るので、生の flush ごとに lock 取得すると `inject` /
    // `team_send` 等の MCP tool と競合して latency 悪化を招く。
    let on_output: Option<PtyOutputObserver> = opts.agent_id.as_ref().map(|aid| {
        let aid = aid.clone();
        let app_for_obs = app.clone();
        let last_update: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));
        Arc::new(move || {
            // dedup: 1 秒以内の連続 flush は no-op
            {
                let now = Instant::now();
                let mut guard = match last_update.try_lock() {
                    Ok(g) => g,
                    // 別 worker が ちょうど update 中なら今回はスキップ (1s 後に拾える)
                    Err(_) => return,
                };
                match *guard {
                    Some(prev) if now.duration_since(prev) < std::time::Duration::from_secs(1) => {
                        return
                    }
                    _ => *guard = Some(now),
                }
            }
            // hub.state.lock() は async なので tokio task に逃がす (flush は同期 callback)
            let aid = aid.clone();
            let app = app_for_obs.clone();
            tauri::async_runtime::spawn(async move {
                let state = match app.try_state::<crate::state::AppState>() {
                    Some(s) => s,
                    None => {
                        tracing::trace!(
                            "[pty-observer] AppState not available; skipping last_pty_output_at update"
                        );
                        return;
                    }
                };
                let hub = state.team_hub.clone();
                let now_iso = chrono::Utc::now().to_rfc3339();
                let mut s = hub.state.lock().await;
                let diag = s.member_diagnostics.entry(aid).or_default();
                diag.last_pty_output_at = Some(now_iso);
            });
        }) as PtyOutputObserver
    });

    spawn_batcher(app.clone(), data_event, rx, scrollback.clone(), on_output);

    // exit watcher (blocking child.wait → emit exit event)
    // Issue #152: child.wait() の後に registry からも remove して、孤立 entry が
    // residual に残らないようにする (renderer が落ちて terminal_kill が呼ばれない経路で必要)。
    let app_for_exit = app.clone();
    let exit_event_clone = exit_event.clone();
    let registry_for_exit = registry.clone();
    let id_for_exit = id.clone();
    std::thread::spawn(move || {
        let exit_status = child.wait().ok();
        let info = TerminalExitInfo {
            exit_code: exit_status
                .as_ref()
                .map(|s| s.exit_code() as i64)
                .unwrap_or(-1),
            signal: None,
        };
        if let Err(e) = app_for_exit.emit(&exit_event_clone, info.clone()) {
            tracing::warn!("emit {exit_event_clone} failed: {e}");
        }
        // child.wait() が返った時点で kill 不要だが、registry::remove は handle.kill() を呼ぶ。
        // SessionHandle::kill() は何度呼んでも安全 (ChildKiller 内部で no-op)。
        let removed = registry_for_exit.remove(&id_for_exit);
        if let Some(handle) = removed {
            if let (Some(team_id), Some(agent_id)) =
                (handle.team_id.clone(), handle.agent_id.clone())
            {
                let output_tail = handle.scrollback_snapshot();
                let app = app_for_exit.clone();
                tauri::async_runtime::spawn(async move {
                    let Some(state) = app.try_state::<crate::state::AppState>() else {
                        return;
                    };
                    let hub = state.team_hub.clone();
                    hub.record_agent_process_exit(&team_id, &agent_id, info.exit_code, output_tail)
                        .await;
                });
            }
        }
    });

    Ok(SessionHandle {
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
        killer: Mutex::new(killer),
        agent_id: opts.agent_id,
        session_key: opts.session_key,
        team_id: opts.team_id,
        role: opts.role,
        cwd: opts.cwd,
        is_codex: opts.is_codex,
        injecting: AtomicBool::new(false),
        write_budget: Mutex::new(WriteBudget {
            window_started_at: Instant::now(),
            bytes_in_window: 0,
        }),
        scrollback,
        // Issue #632: watcher cancel token は session 起動と同寿命。kill() / Drop で flip。
        watcher_cancel: Arc::new(AtomicBool::new(false)),
    })
}

/// Issue #618: Windows ConPTY 起動直後に shell の出力 codepage を UTF-8 に強制する初期コマンドを
/// `writer` (PTY master) に流すヘルパー。`force_utf8` が false、対象シェルが cmd / pwsh /
/// powershell でないとき、または `command_validation::windows_utf8_init_command` が None を
/// 返すとき (= bash / sh / nu / claude / codex / 不明シェル) は no-op で `Ok(None)`。
///
/// 戻り値は inject されたバイト列の参照 (test 用、failure path と区別するため `Result<Option>`):
///   - `Ok(Some(bytes))`: bytes が writer に書き込まれた
///   - `Ok(None)`: no-op (force_utf8=false / 対象外シェル)
///   - `Err(io::Error)`: writer.write_all / writer.flush 失敗
///
/// platform check (`cfg!(windows)`) は呼び出し側で行う想定。本関数自体は platform-agnostic で
/// テスト時も統一的に動く (Linux CI でも `cmd` を渡せば bytes を返す)。
pub(crate) fn maybe_inject_windows_utf8_init(
    writer: &mut dyn Write,
    command: &str,
    force_utf8: bool,
) -> std::io::Result<Option<&'static [u8]>> {
    if !force_utf8 {
        return Ok(None);
    }
    let Some(init) = command_validation::windows_utf8_init_command(command) else {
        return Ok(None);
    };
    writer.write_all(init)?;
    writer.flush()?;
    Ok(Some(init))
}

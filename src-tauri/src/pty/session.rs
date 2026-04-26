// PTY セッション本体
//
// 旧 ipc/terminal.ts の `pty.spawn(...)` 部分を移植。
// portable-pty + tokio + tauri::Emitter で同等機能を再現。

use crate::pty::batcher::spawn_batcher;
use anyhow::{anyhow, Result};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitInfo {
    pub exit_code: i64,
    pub signal: Option<i32>,
}

pub struct SpawnOptions {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub env: HashMap<String, String>,
    pub agent_id: Option<String>,
    pub team_id: Option<String>,
    pub role: Option<String>,
}

/// 1 セッションぶんの状態。kill / write / resize 用に master と writer を Mutex 保持。
pub struct SessionHandle {
    /// 旧 Session.pty.write 相当
    writer: Mutex<Box<dyn Write + Send>>,
    /// resize 用に保持
    master: Mutex<Box<dyn MasterPty + Send>>,
    /// kill 用 (子プロセス側 — drop で殺せないことがあるため明示保持)
    killer: Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
    pub agent_id: Option<String>,
    pub team_id: Option<String>,
    pub role: Option<String>,
    /// Issue #153: prompt injection 中はユーザー入力を抑止する。
    /// `inject_codex_prompt_to_pty` 等が begin/end で立て下げる。
    /// renderer 側からの terminal_write は user_write 経由でこのフラグを見る。
    injecting: std::sync::atomic::AtomicBool,
}

impl SessionHandle {
    /// 内部 / inject 経路用: フラグの状態にかかわらず常に書き込む。
    pub fn write(&self, data: &[u8]) -> Result<()> {
        let mut w = self
            .writer
            .lock()
            .map_err(|e| anyhow!("writer lock poisoned: {e}"))?;
        w.write_all(data)?;
        w.flush()?;
        Ok(())
    }

    /// Issue #153: ユーザー入力 (renderer の terminal_write) 経路は inject 中なら drop。
    /// 戻り値: 実際に書き込んだら true、injecting で抑止したら false。
    pub fn user_write(&self, data: &[u8]) -> Result<bool> {
        if self.injecting.load(std::sync::atomic::Ordering::Acquire) {
            return Ok(false);
        }
        self.write(data)?;
        Ok(true)
    }

    pub fn set_injecting(&self, on: bool) {
        self.injecting
            .store(on, std::sync::atomic::Ordering::Release);
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        let m = self
            .master
            .lock()
            .map_err(|e| anyhow!("master lock poisoned: {e}"))?;
        m.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    pub fn kill(&self) -> Result<()> {
        let mut k = self
            .killer
            .lock()
            .map_err(|e| anyhow!("killer lock poisoned: {e}"))?;
        let _ = k.kill();
        Ok(())
    }
}

/// Issue #144: SessionHandle が drop されたタイミングで child プロセスを必ず kill する。
/// SessionRegistry::remove() は kill を呼ばずに Map から外すだけだったため、
/// Arc の参照が残っている間 reader thread が PTY master を保持し続け、
/// 子プロセス + reader thread が孤立リークしていた。
///
/// drop でも kill を呼ぶことで「registry から外す = reader が EOF を読む = thread 終了」
/// が確実に成立する。kill 時の Mutex poison はこの段階では recovery 不能なので無視 (best-effort)。
impl Drop for SessionHandle {
    fn drop(&mut self) {
        if let Ok(mut k) = self.killer.lock() {
            let _ = k.kill();
        }
    }
}

/// `cwd` の検証 (旧 resolveValidCwd と同等)。
/// 無効なら fallback → カレントディレクトリ。warning メッセージも返す。
pub fn resolve_valid_cwd(
    requested: &str,
    fallback: Option<&str>,
) -> (String, Option<String>) {
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
                    if requested.is_empty() { "(未設定)" } else { requested },
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
            if requested.is_empty() { "(未設定)" } else { requested },
            cwd
        )),
    )
}

/// PTY を 1 つ生成、reader thread を起動、batcher を回し、exit watcher も spawn。
/// 戻り値の SessionHandle は SessionRegistry に登録される。
/// Issue #54 / #139: 子プロセスに渡さない環境変数を判定する。
/// - 非 team 端末 (`is_team = false`) では `VIBE_TEAM_*` / `VIBE_AGENT_ID` も剥がす。
/// - シークレット接頭辞 / 接尾辞 / 完全一致 + 一般 secret 命名パターンの denylist。
///
/// 完全な allowlist 化は破壊的変更 (ユーザーの開発フローで使う任意 env が落ちる) なので、
/// 当面は denylist を強化し、`*_TOKEN` `*_KEY` `*_SECRET` `*_PASSWORD` などの一般パターンも
/// 弾く方式に拡張する。
fn should_strip_env(key: &str, is_team: bool) -> bool {
    // vibe-editor 内部 env: team 外には漏らさない
    if !is_team && (key.starts_with("VIBE_TEAM_") || key == "VIBE_AGENT_ID") {
        return true;
    }
    // team 端末では VIBE_TEAM_* / VIBE_AGENT_ID は明示的に流す。
    // 以下の汎用 *_TOKEN パターンに `VIBE_TEAM_TOKEN` 等が引っかからないよう先に return false。
    if is_team && (key.starts_with("VIBE_TEAM_") || key == "VIBE_AGENT_ID") {
        return false;
    }

    let upper = key.to_ascii_uppercase();

    // (1) 接頭辞 prefix denylist
    const SECRET_PREFIXES: &[&str] = &[
        "AWS_",
        "GITHUB_",
        "GH_",
        "OPENAI_",
        "ANTHROPIC_",
        "AZURE_",
        "GCP_",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "CLOUDFLARE_",
        "STRIPE_",
        "NPM_TOKEN",
        "HF_TOKEN",
        "HUGGINGFACE_",
        // Issue #139 で追加
        "CLAUDE_",
        "SLACK_",
        "DISCORD_",
        "TWILIO_",
        "SENTRY_",
        "SUPABASE_",
        "DOPPLER_",
        "VAULT_",
        "HCP_",
        "DOCKER_",
        "GITLAB_",
        "OP_SESSION_",
        "OP_",
        "POSTGRES_",
        "MYSQL_",
        "MARIADB_",
        "REDIS_",
        "MONGO_",
        "MONGODB_",
        "ELASTICSEARCH_",
        "ELASTIC_",
        "CIRCLECI_",
        "BUILDKITE_",
        "VERCEL_",
        "NETLIFY_",
        "RAILWAY_",
        "FLY_",
        "DATABASE_",
    ];
    if SECRET_PREFIXES.iter().any(|p| upper.starts_with(p)) {
        return true;
    }

    // (2) 接尾辞 suffix の一般パターン (*_TOKEN / *_KEY / *_SECRET / *_PASSWORD / *_PWD)
    const SECRET_SUFFIXES: &[&str] = &[
        "_TOKEN",
        "_API_KEY",
        "_SECRET",
        "_SECRET_KEY",
        "_PASSWORD",
        "_PASSWD",
        "_PWD",
        "_AUTH",
        "_ACCESS_KEY",
    ];
    if SECRET_SUFFIXES.iter().any(|s| upper.ends_with(s)) {
        return true;
    }

    // (3) 完全一致 (パターンに引っ掛からない著名な env)
    const SECRET_EXACT: &[&str] = &[
        "DATABASE_URL",
        "MYSQL_PWD",
        "PGPASSWORD",
        "REDIS_URL",
        "MONGO_URL",
        "MONGODB_URI",
        "KUBECONFIG",
        "DOCKER_AUTH_CONFIG",
        "SSH_AUTH_SOCK",
        "GPG_AGENT_INFO",
        "AWS_PROFILE",
    ];
    if SECRET_EXACT.iter().any(|e| upper == *e) {
        return true;
    }

    false
}

#[cfg(test)]
mod env_strip_tests {
    use super::should_strip_env;

    #[test]
    fn strips_vibe_team_in_nonteam_mode() {
        assert!(should_strip_env("VIBE_TEAM_TOKEN", false));
        assert!(should_strip_env("VIBE_AGENT_ID", false));
        assert!(!should_strip_env("VIBE_TEAM_TOKEN", true));
    }

    #[test]
    fn strips_common_secrets() {
        assert!(should_strip_env("AWS_SECRET_ACCESS_KEY", false));
        assert!(should_strip_env("GITHUB_TOKEN", false));
        assert!(should_strip_env("OPENAI_API_KEY", false));
        assert!(should_strip_env("ANTHROPIC_API_KEY", false));
        // Issue #139 で追加した DB / cloud / dev tool 系
        assert!(should_strip_env("DATABASE_URL", false));
        assert!(should_strip_env("POSTGRES_PASSWORD", false));
        assert!(should_strip_env("MYSQL_PWD", false));
        assert!(should_strip_env("REDIS_URL", false));
        assert!(should_strip_env("KUBECONFIG", false));
        assert!(should_strip_env("DOCKER_AUTH_CONFIG", false));
        assert!(should_strip_env("SSH_AUTH_SOCK", false));
        assert!(should_strip_env("OP_SESSION_abc", false));
        assert!(should_strip_env("DOPPLER_TOKEN", false));
        assert!(should_strip_env("VAULT_TOKEN", false));
        assert!(should_strip_env("CLAUDE_API_KEY", false));
        assert!(should_strip_env("SLACK_TOKEN", false));
        assert!(should_strip_env("MY_PRIVATE_TOKEN", false)); // suffix 一般パターン
        assert!(should_strip_env("APP_SECRET", false));
        assert!(should_strip_env("DB_PASSWORD", false));
    }

    #[test]
    fn keeps_ordinary_env() {
        assert!(!should_strip_env("PATH", false));
        assert!(!should_strip_env("HOME", false));
        assert!(!should_strip_env("LANG", false));
        assert!(!should_strip_env("USER", false));
        assert!(!should_strip_env("TERM", false));
    }
}

pub fn spawn_session(
    app: AppHandle,
    id: String,
    opts: SpawnOptions,
    registry: std::sync::Arc<crate::pty::SessionRegistry>,
) -> Result<SessionHandle> {
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: opts.rows.max(5),
        cols: opts.cols.max(20),
        pixel_width: 0,
        pixel_height: 0,
    })?;

    // Windows: PATHEXT 経由で .cmd / .bat / .exe を解決する。
    // 旧 node-pty は内部で同等処理をしていたため、claude → claude.cmd の自動解決が必要。
    let resolved_command = which::which(&opts.command)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| opts.command.clone());
    let mut cmd = CommandBuilder::new(&resolved_command);
    for a in &opts.args {
        cmd.arg(a);
    }
    cmd.cwd(&opts.cwd);
    // 既存 env を継承しつつ上書きする。
    // Issue #54: ただし機密が漏れる可能性があるもの (開発者シェルの API key や、
    // 以前の team 端末が親 env に残した VIBE_TEAM_*) は明示的に除外する。
    //
    // 除外方針:
    //   1. 典型的なシークレット接頭辞を denylist で落とす (AWS_, GITHUB_TOKEN, etc)
    //   2. VIBE_TEAM_* / VIBE_AGENT_ID は team 用途なので、非 team 端末では必ず除去
    //      (team 端末では opts.env で明示的に上書きされる)
    //   3. HOME / PATH / USER / LANG 等の基本 env は継承する (whitelist にすると
    //      SHELL 起動や npx 実行が動かなくなるので現実的ではない)
    let is_team = opts
        .env
        .iter()
        .any(|(k, _)| k == "VIBE_TEAM_TOKEN" || k == "VIBE_TEAM_SOCKET");
    for (k, v) in std::env::vars() {
        if should_strip_env(&k, is_team) {
            continue;
        }
        cmd.env(k, v);
    }
    for (k, v) in &opts.env {
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let mut child = pair.slave.spawn_command(cmd)?;
    drop(pair.slave);

    let killer = child.clone_killer();

    // reader thread (blocking IO -> mpsc)
    let mut reader = pair.master.try_clone_reader()?;
    let writer = pair.master.take_writer()?;

    let data_event = format!("terminal:data:{id}");
    let exit_event = format!("terminal:exit:{id}");

    // Issue #53: bounded channel で reader → batcher に backpressure をかける。
    //   reader (std::thread) は `blocking_send` でチャネル満杯時に待機 → OS 側で PTY
    //   への入力が詰まれば子プロセスが書き込み待ちに入るので、メモリ無限膨張を防げる。
    let (tx, rx) = mpsc::channel::<Vec<u8>>(crate::pty::batcher::PTY_CHANNEL_CAPACITY);
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
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

    spawn_batcher(app.clone(), data_event, rx);

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
        if let Err(e) = app_for_exit.emit(&exit_event_clone, info) {
            tracing::warn!("emit {exit_event_clone} failed: {e}");
        }
        // child.wait() が返った時点で kill 不要だが、registry::remove は handle.kill() を呼ぶ。
        // SessionHandle::kill() は何度呼んでも安全 (ChildKiller 内部で no-op)。
        let _ = registry_for_exit.remove(&id_for_exit);
    });

    Ok(SessionHandle {
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
        killer: Mutex::new(killer),
        agent_id: opts.agent_id,
        team_id: opts.team_id,
        role: opts.role,
        injecting: std::sync::atomic::AtomicBool::new(false),
    })
}

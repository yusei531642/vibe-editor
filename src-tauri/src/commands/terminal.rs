// terminal.* command — 旧 src/main/ipc/terminal.ts に対応
//
// portable-pty 経由で PTY を spawn、SessionRegistry に登録、
// terminal:data:{id} / terminal:exit:{id} イベントを emit する。

use crate::pty::{spawn_session, SpawnOptions, UserWriteOutcome};
use crate::state::AppState;
use crate::team_hub::inject::build_chunks;
use crate::util::log_redact::redact_home;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, State};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCreateOptions {
    /// Issue #285: renderer が pre-subscribe 用に渡すクライアント側生成 id。
    /// `[A-Za-z0-9_-]{1,64}` 以外や未指定の場合は Rust 側で UUID を生成する。
    #[serde(default)]
    pub id: Option<String>,
    pub cwd: String,
    #[serde(default)]
    pub fallback_cwd: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Option<Vec<String>>,
    pub cols: u32,
    pub rows: u32,
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
    #[serde(default)]
    pub team_id: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    /// Issue #271: HMR 経路で同じ React mount identity を共有する論理キー。
    #[serde(default)]
    pub session_key: Option<String>,
    /// Issue #271: true の場合、同じ session_key / agent_id の生存 PTY があれば
    /// spawn せず既存 id を返す。デフォルトは false (従来通り常に新規 spawn)。
    #[serde(default)]
    pub attach_if_exists: bool,
    #[serde(default)]
    pub codex_instructions: Option<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCreateResult {
    pub ok: bool,
    pub id: Option<String>,
    pub error: Option<String>,
    pub command: Option<String>,
    pub warning: Option<String>,
    /// Issue #271: attachIfExists により既存 PTY に接続した場合 true。新規 spawn 時は None。
    pub attached: Option<bool>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SavePastedImageResult {
    pub ok: bool,
    pub path: Option<String>,
    pub error: Option<String>,
}

/// Issue #285: renderer から渡される terminal id を検証。
/// `terminal:data:{id}` 等のイベント名に乗るので、衝突や偽装防止のため
/// `[A-Za-z0-9_-]{1,64}` のみ許可する (UUID v4 は 36 chars で収まる)。
fn is_valid_terminal_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// 旧 resolveCommand 相当の最小実装。Phase 1 では「未指定なら 'claude'」だけ。
fn resolve_command(command: Option<String>, args: Option<Vec<String>>) -> (String, Vec<String>) {
    let cmd = command
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "claude".to_string());
    (cmd, args.unwrap_or_default())
}

fn command_basename(command: &str) -> String {
    let lower = command.trim().to_ascii_lowercase().replace('\\', "/");
    std::path::Path::new(&lower)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(lower.as_str())
        .to_string()
}

fn configured_terminal_commands() -> HashSet<String> {
    let mut out = HashSet::new();
    let Some(home) = dirs::home_dir() else {
        return out;
    };
    let path = home.join(".vibe-editor").join("settings.json");
    let Ok(bytes) = std::fs::read(path) else {
        return out;
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return out;
    };
    let mut push = |raw: Option<&str>| {
        if let Some(cmd) = raw.map(str::trim).filter(|s| !s.is_empty()) {
            out.insert(cmd.to_ascii_lowercase());
        }
    };
    push(value.get("claudeCommand").and_then(|v| v.as_str()));
    push(value.get("codexCommand").and_then(|v| v.as_str()));
    if let Some(custom) = value.get("customAgents").and_then(|v| v.as_array()) {
        for agent in custom {
            push(agent.get("command").and_then(|v| v.as_str()));
        }
    }
    out
}

/// Issue #201:
/// renderer 由来の任意コマンド実行を避けるため、起動できるバイナリを
/// 1. 組み込み allowlist (Claude / Codex / 代表的な対話シェル)
/// 2. ユーザーが settings.json に保存した既知の command
/// に限定する。
fn is_allowed_terminal_command(command: &str) -> bool {
    const SAFE_BASENAMES: &[&str] = &[
        "claude",
        "codex",
        "bash",
        "sh",
        "zsh",
        "fish",
        "pwsh",
        "powershell",
        "cmd",
        "nu",
    ];
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return false;
    }
    let basename = command_basename(trimmed);
    if SAFE_BASENAMES.contains(&basename.as_str()) {
        return true;
    }
    configured_terminal_commands().contains(&trimmed.to_ascii_lowercase())
}

fn reject_immediate_exec_args(command: &str, args: &[String]) -> Option<&'static str> {
    let basename = command_basename(command);
    let lower_args: Vec<String> = args.iter().map(|a| a.trim().to_ascii_lowercase()).collect();
    let has_any = |candidates: &[&str]| lower_args.iter().any(|arg| candidates.contains(&arg.as_str()));
    match basename.as_str() {
        "bash" | "sh" | "zsh" | "fish" => {
            if has_any(&["-c", "-lc"]) {
                Some("shell immediate-exec flags (-c / -lc) are blocked")
            } else {
                None
            }
        }
        "pwsh" | "powershell" => {
            if has_any(&["-c", "-command", "/command", "-encodedcommand", "-file"]) {
                Some("PowerShell immediate-exec flags (-Command / -EncodedCommand / -File) are blocked")
            } else {
                None
            }
        }
        "cmd" => {
            if has_any(&["/c", "/k"]) {
                Some("cmd immediate-exec flags (/c /k) are blocked")
            } else {
                None
            }
        }
        "nu" => {
            if has_any(&["-c", "--commands"]) {
                Some("nushell immediate-exec flags (-c / --commands) are blocked")
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Issue #99: Codex の system prompt を一時ファイルに書き、`--config model_instructions_file=...`
/// を args 末尾に追加する。書き出し先は `~/.vibe-editor/codex-instructions/`。
/// ディレクトリは起動時に best-effort で TTL=7日 のクリーンアップを掛ける。
async fn prepare_codex_instructions_file(instructions: &str) -> Option<PathBuf> {
    if instructions.trim().is_empty() {
        return None;
    }
    let dir = dirs::home_dir()
        .unwrap_or_default()
        .join(".vibe-editor")
        .join("codex-instructions");
    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        tracing::warn!("[terminal] codex-instructions dir create failed: {e}");
        return None;
    }
    cleanup_old_codex_instructions(&dir).await;
    let path = dir.join(format!("instr-{}.md", Uuid::new_v4()));
    if let Err(e) = tokio::fs::write(&path, instructions).await {
        tracing::warn!("[terminal] codex-instructions write failed: {e}");
        return None;
    }
    Some(path)
}

/// Issue #99: 古い codex 指示ファイルを TTL で掃除 (paste-images と同じ best-effort)。
async fn cleanup_old_codex_instructions(dir: &std::path::Path) {
    // Issue #138: 旧 7 日 → 24h に短縮。情報残存リスクを下げる
    const TTL_SECS: u64 = 24 * 60 * 60;
    let mut rd = match tokio::fs::read_dir(dir).await {
        Ok(r) => r,
        Err(_) => return,
    };
    let now = std::time::SystemTime::now();
    while let Ok(Some(entry)) = rd.next_entry().await {
        let Ok(meta) = entry.metadata().await else { continue };
        let Ok(modified) = meta.modified() else { continue };
        let age = now.duration_since(modified).unwrap_or_default();
        if age.as_secs() > TTL_SECS {
            let _ = tokio::fs::remove_file(entry.path()).await;
        }
    }
}

/// Codex の system prompt を、PTY (TUI) に直接「最初の入力」として注入する fallback 経路。
///
/// 動作:
///   1. spawn 直後 1.8 秒スリープして Codex の TUI が prompt 入力を受け付ける状態になるのを待つ。
///   2. team_hub::inject::build_chunks で ConPTY-safe チャンク (64B / 15ms / UTF-8 境界保護) に
///      整形 (banner は空文字)。
///   3. 各チャンクを順に書き込み、最後に \r で確定送信。
///
/// チームメッセージの inject() と違って banner は付けない (Codex に対する初手のユーザー指示として届く)。
async fn inject_codex_prompt_to_pty(
    registry: Arc<crate::pty::SessionRegistry>,
    term_id: String,
    instructions: String,
) {
    use tokio::time::sleep;
    sleep(Duration::from_millis(1800)).await;
    let session = match registry.get(&term_id) {
        Some(s) => s,
        None => return,
    };
    // Issue #153: 注入中はユーザーの xterm 入力 (terminal_write) を抑止する。
    // build_chunks は banner 込みで分割するが、Codex 注入では banner 不要なので空文字を渡す。
    session.set_injecting(true);
    // 関数を抜けるあらゆる経路で必ず injecting を下ろすため、内部処理を closure で wrap せず
    // 早期 return ごとに明示 false に戻す。
    let chunks = build_chunks("", &instructions);
    if chunks.is_empty() {
        session.set_injecting(false);
        return;
    }
    let mut iter = chunks.into_iter();
    if let Some(first) = iter.next() {
        if session.write(&first).is_err() {
            session.set_injecting(false);
            return;
        }
    }
    for chunk in iter {
        sleep(Duration::from_millis(15)).await;
        if registry.get(&term_id).is_none() {
            session.set_injecting(false);
            return;
        }
        if session.write(&chunk).is_err() {
            session.set_injecting(false);
            return;
        }
    }
    sleep(Duration::from_millis(15)).await;
    let _ = session.write(b"\r");
    session.set_injecting(false);
    tracing::info!(
        "[terminal] codex prompt injected into pty {term_id} ({} bytes)",
        instructions.len()
    );
}

/// command が codex 系か判定 (パス形式や *.exe も拾う)
///
/// Path::new は OS のセパレータしか認識しない (Linux では `\` が単なる文字扱い) ので、
/// Windows-style な `C:\tools\codex.exe` も Linux CI で正しく判定できるよう、
/// 先に `/` `\` 双方をスラッシュに正規化してから basename を取り出す。
fn is_codex_command(command: &str) -> bool {
    let lower = command.to_ascii_lowercase().replace('\\', "/");
    let basename = std::path::Path::new(&lower)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(&lower);
    basename == "codex" || basename.ends_with("-codex") || basename.starts_with("codex-")
}

#[cfg(test)]
mod terminal_id_validation_tests {
    use super::is_valid_terminal_id;

    #[test]
    fn accepts_uuid_v4() {
        assert!(is_valid_terminal_id("550e8400-e29b-41d4-a716-446655440000"));
    }

    #[test]
    fn accepts_alphanumeric_and_separators() {
        assert!(is_valid_terminal_id("abc_123-XYZ"));
        assert!(is_valid_terminal_id("term-1761800000000-abcd1234"));
        assert!(is_valid_terminal_id("a"));
        assert!(is_valid_terminal_id("0"));
    }

    #[test]
    fn accepts_max_length() {
        let s = "a".repeat(64);
        assert!(is_valid_terminal_id(&s));
    }

    #[test]
    fn rejects_empty() {
        assert!(!is_valid_terminal_id(""));
    }

    #[test]
    fn rejects_overlength() {
        let s = "a".repeat(65);
        assert!(!is_valid_terminal_id(&s));
    }

    #[test]
    fn rejects_path_traversal() {
        assert!(!is_valid_terminal_id("../etc/passwd"));
        assert!(!is_valid_terminal_id("./id"));
    }

    #[test]
    fn rejects_event_name_injection() {
        // ":" を入れると `terminal:data:foo:bar` のように Tauri event 名前空間を細工される懸念
        assert!(!is_valid_terminal_id("foo:bar"));
        assert!(!is_valid_terminal_id("data:malicious"));
    }

    #[test]
    fn rejects_whitespace_and_shell_metachars() {
        assert!(!is_valid_terminal_id("abc def"));
        assert!(!is_valid_terminal_id("abc;rm"));
        assert!(!is_valid_terminal_id("abc|true"));
        assert!(!is_valid_terminal_id("abc$VAR"));
        assert!(!is_valid_terminal_id("abc`whoami`"));
    }

    #[test]
    fn rejects_non_ascii() {
        assert!(!is_valid_terminal_id("日本語"));
        assert!(!is_valid_terminal_id("café"));
    }
}

#[cfg(test)]
mod codex_command_tests {
    use super::is_codex_command;

    #[test]
    fn detects_basic_codex() {
        assert!(is_codex_command("codex"));
        assert!(is_codex_command("CODEX"));
        assert!(is_codex_command("/usr/local/bin/codex"));
        assert!(is_codex_command(r"C:\tools\codex.exe"));
    }

    #[test]
    fn rejects_non_codex() {
        assert!(!is_codex_command("claude"));
        assert!(!is_codex_command("bash"));
        assert!(!is_codex_command(""));
    }
}

#[tauri::command]
pub async fn terminal_create(
    app: AppHandle,
    state: State<'_, AppState>,
    opts: TerminalCreateOptions,
) -> Result<TerminalCreateResult, String> {
    let (command, mut args) = resolve_command(opts.command, opts.args);
    if !is_allowed_terminal_command(&command) {
        return Ok(TerminalCreateResult {
            ok: false,
            error: Some(format!("command is not allowed: {command}")),
            ..Default::default()
        });
    }
    if let Some(reason) = reject_immediate_exec_args(&command, &args) {
        return Ok(TerminalCreateResult {
            ok: false,
            error: Some(reason.to_string()),
            ..Default::default()
        });
    }

    // Issue #271: HMR remount 経路では renderer 側 hook が `attachIfExists: true` を立て、
    // 既存 PTY に bind し直したいシグナルを送る。allowlist / immediate-exec チェックを通った
    // 後・コマンドラインを組み立てる前 (codex 一時ファイル作成より前) に preflight して、
    // 同じ session_key / agent_id の生存 PTY があれば spawn せず既存 id をそのまま返す。
    if opts.attach_if_exists {
        if let Some(existing_id) = state
            .pty_registry
            .find_attach_target(opts.session_key.as_deref(), opts.agent_id.as_deref())
        {
            tracing::info!(
                "[terminal] attach_if_exists hit — reusing existing pty {} (session_key={:?}, agent_id={:?})",
                existing_id,
                opts.session_key,
                opts.agent_id
            );
            // attach 経路では既存 PTY の本物のコマンドラインを registry が保持していない
            // ため、今回リクエストされた command/args から表示用文字列を再構成する。
            // renderer の status ラインは "実行中: ..." を再現できれば充分で、PTY の実体
            // コマンドと一致しなくても挙動には影響しない (HMR remount 時は親が同じ
            // command/args を渡してくる前提)。
            let cmdline = std::iter::once(command.clone())
                .chain(args.iter().cloned())
                .collect::<Vec<_>>()
                .join(" ");
            return Ok(TerminalCreateResult {
                ok: true,
                id: Some(existing_id),
                command: Some(cmdline),
                attached: Some(true),
                ..Default::default()
            });
        }
    }

    let (cwd, warning) =
        crate::pty::session::resolve_valid_cwd(&opts.cwd, opts.fallback_cwd.as_deref());

    // Issue #99 / Codex stability: codex かつ instructions ありなら、
    // (1) 一時ファイル化して `--config model_instructions_file=<path>` を args 末尾に追加 (古い経路)。
    // (2) さらに、起動後に PTY 直接注入する fallback 経路もセットしておく。
    //     Codex CLI のバージョンによっては (1) の config キーが効かないことが報告されており、
    //     その場合でもプロンプトが「最初の user input」としては必ず届くようにする。
    //     team_hub::inject::build_chunks を共有して ConPTY-safe (64B / 15ms チャンク + UTF-8 境界保護) な
    //     注入を行う。同じロジックでチームメッセージの注入と挙動を揃えることで、xterm 表示の崩れも避けられる。
    let codex_instructions_for_inject: Option<String> = if is_codex_command(&command) {
        if let Some(instr) = opts
            .codex_instructions
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            if let Some(path) = prepare_codex_instructions_file(instr).await {
                let path_str = path.to_string_lossy().into_owned();
                tracing::info!(
                    "[terminal] codex model_instructions_file={path_str}"
                );
                args.push("--config".to_string());
                args.push(format!("model_instructions_file={path_str}"));
            }
            Some(instr.to_string())
        } else {
            None
        }
    } else {
        None
    };

    // Issue #140 (Security): args 内の絶対パス (Codex --config model_instructions_file=...
    // 等) や cwd の絶対パスが bug report ログに残ると user 名 / OS 構成 / project 情報が漏れる。
    // INFO level は引数省略・cwd の home 部分を ~ にマスクし、詳細は DEBUG にだけ残す。
    tracing::info!(
        "[IPC] terminal_create command={command} args.len={} cwd={} cols={} rows={}",
        args.len(),
        redact_home(&cwd),
        opts.cols,
        opts.rows
    );
    tracing::debug!(
        "[IPC] terminal_create (verbose) args={args:?} cwd={cwd}"
    );

    if let Some(w) = &warning {
        tracing::warn!("[terminal] {w}");
    }

    // Issue #285: renderer が指定した id があれば採用 (event 名 `terminal:data:{id}` に
    // 安全な文字種だけ通す)。`attach_if_exists` 経路は preflight で既に return 済みで、
    // ここに到達するのは「新規 spawn 経路」だけなので、両者は構造的に直交している。
    // 不正値・未指定は UUID v4 にフォールバック。既存 PTY との衝突は実質起こらない
    // (UUID v4 の 122-bit エントロピー) が、安全側で衝突時も UUID にフォールバックする。
    // ※ 衝突は registry の lock を握らない get→ 採用→ insert の TOCTOU を含むため、
    //   完全な atomic 化はフォローアップ issue 扱い (実害シナリオは UUID 衝突ほぼ皆無)。
    let id = match opts.id.as_deref() {
        Some(s) if !is_valid_terminal_id(s) => {
            tracing::warn!(
                "[terminal] renderer-supplied id rejected (invalid charset/length), falling back to UUID v4"
            );
            Uuid::new_v4().to_string()
        }
        Some(s) if state.pty_registry.get(s).is_some() => {
            tracing::warn!(
                "[terminal] renderer-supplied id {s} collides with existing PTY, falling back to UUID v4"
            );
            Uuid::new_v4().to_string()
        }
        Some(s) => s.to_string(),
        None => Uuid::new_v4().to_string(),
    };

    // チーム所属端末なら TeamHub の socket/token と team/agent/role を env に注入
    let mut env = opts.env.unwrap_or_default();
    if let Some(team_id) = &opts.team_id {
        let (socket, token, _) = state.team_hub.info().await;
        env.insert("VIBE_TEAM_SOCKET".into(), socket);
        env.insert("VIBE_TEAM_TOKEN".into(), token);
        env.insert("VIBE_TEAM_ID".into(), team_id.clone());
        if let Some(role) = &opts.role {
            env.insert("VIBE_TEAM_ROLE".into(), role.clone());
        }
        if let Some(aid) = &opts.agent_id {
            env.insert("VIBE_AGENT_ID".into(), aid.clone());
        }
    }

    let spawn_opts = SpawnOptions {
        command: command.clone(),
        args: args.clone(),
        cwd,
        cols: opts.cols.min(u32::from(u16::MAX)) as u16,
        rows: opts.rows.min(u32::from(u16::MAX)) as u16,
        env,
        agent_id: opts.agent_id,
        // Issue #271: session_key を SpawnOptions / SessionHandle 経由で
        // SessionRegistry::insert に届け、by_session_key index を更新できるようにする。
        session_key: opts.session_key,
        team_id: opts.team_id,
        role: opts.role,
    };

    match spawn_session(app.clone(), id.clone(), spawn_opts, state.pty_registry.clone()) {
        Ok(handle) => {
            state.pty_registry.insert(id.clone(), handle);

            // Codex stability: 起動した PTY に「最初の user メッセージ」として instructions を注入する。
            // - 1.8 秒待ってから注入 (TUI の初期化 / banner 描画完了を待つ目安)。早すぎると Codex の入力欄が
            //   まだ準備できておらず文字が捨てられる。実機計測でこの値は十分。
            // - 注入は非同期 task で行い terminal_create のレスポンスはブロックしない。
            // - チームメッセージと同じ build_chunks (64B/15ms, UTF-8 境界保護) を使う。
            // - チーム所属端末 (team_hub) では Hub 側でメッセージを別途注入する設計なので、
            //   チーム所属の場合 (team_id ありかつ role が leader/hr 等) は重複注入を避けるため、
            //   AgentNodeCard 側が --append-system-prompt を渡す Claude と同じく、
            //   Codex でも sysPrompt を `codex_instructions` で渡す経路を Hub 注入と分離している。
            //   ここでは「ユーザーが最初に伝えたい一言」相当を直接落とすだけで充分動く。
            if let Some(instr) = codex_instructions_for_inject {
                let registry = state.pty_registry.clone();
                let term_id = id.clone();
                tauri::async_runtime::spawn(async move {
                    inject_codex_prompt_to_pty(registry, term_id, instr).await;
                });
            }
            // Claude Code 起動時のみ session watcher を仕掛ける (codex は jsonl を作らない)
            if command.to_lowercase().contains("claude") {
                let registry = state.pty_registry.clone();
                let watcher_id = id.clone();
                // Issue #147: poison でも recovery して読む
                let watcher_root = crate::state::lock_project_root_recover(&state.project_root)
                    .clone()
                    .unwrap_or_default();
                let actual_root = if watcher_root.is_empty() {
                    // PTY spawn 時の cwd を流用
                    std::env::current_dir()
                        .map(|p| p.to_string_lossy().into_owned())
                        .unwrap_or_default()
                } else {
                    watcher_root
                };
                crate::pty::claude_watcher::spawn_watcher(app.clone(), watcher_id.clone(), actual_root, move || {
                    registry.get(&watcher_id).is_some()
                });
            }
            let cmdline = std::iter::once(command.clone())
                .chain(args.iter().cloned())
                .collect::<Vec<_>>()
                .join(" ");
            Ok(TerminalCreateResult {
                ok: true,
                id: Some(id),
                command: Some(cmdline),
                warning,
                error: None,
                // Issue #271: 新規 spawn は明示的に Some(false)。renderer 側で
                // 「attach 復帰経路かどうか」を毎回判別するときの不確実性をなくす。
                attached: Some(false),
            })
        }
        Err(e) => Ok(TerminalCreateResult {
            ok: false,
            error: Some(format!("{e:#}")),
            ..Default::default()
        }),
    }
}

#[tauri::command]
pub async fn terminal_write(
    state: State<'_, AppState>,
    id: String,
    data: String,
) -> Result<(), String> {
    if let Some(s) = state.pty_registry.get(&id) {
        match s.user_write(data.as_bytes()).map_err(|e| e.to_string())? {
            UserWriteOutcome::Written | UserWriteOutcome::SuppressedInjecting => {}
            UserWriteOutcome::DroppedTooLarge => {
                tracing::warn!(
                    "[terminal] dropped oversized terminal_write payload for {id}: {} bytes",
                    data.len()
                );
            }
            UserWriteOutcome::DroppedRateLimited => {
                tracing::warn!(
                    "[terminal] rate-limited terminal_write for {id}: {} bytes",
                    data.len()
                );
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn terminal_resize(
    state: State<'_, AppState>,
    id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    if let Some(s) = state.pty_registry.get(&id) {
        // resize 失敗は無害なので握りつぶす (旧実装と同じ)
        let _ = s.resize(cols.min(u32::from(u16::MAX)) as u16, rows.min(u32::from(u16::MAX)) as u16);
    }
    Ok(())
}

#[tauri::command]
pub async fn terminal_kill(state: State<'_, AppState>, id: String) -> Result<(), String> {
    if let Some(s) = state.pty_registry.remove(&id) {
        let _ = s.kill();
    }
    Ok(())
}

/// Issue #40: mime_type から拡張子を決める。未知 mime は .png にフォールバック。
/// Issue #138: SVG はスクリプト埋め込み可能な XML 形式で、AI agent が paste image
/// path を読みに行ったときにプロンプトインジェクション / XSS の足掛かりになる。
/// SVG は Option::None を返して保存自体を拒否させる。
fn extension_for_mime(mime: &str) -> Option<&'static str> {
    match mime.trim().to_ascii_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        "image/bmp" => Some("bmp"),
        "image/tiff" => Some("tiff"),
        // image/svg+xml は除外 (上記 issue 参照)
        // 未知 mime も拒否 (旧 fallback="png" は MIME 検証ザル経路だった)
        _ => None,
    }
}

/// Issue #41: paste-images/ 配下のうち mtime が 7 日以上古いファイルを削除。
/// paste の度に best-effort で呼ばれ、長期利用時のゴミ蓄積を防ぐ。
async fn cleanup_old_paste_images(dir: &std::path::Path) {
    // Issue #138: 旧 7 日 → 24h に短縮。情報残存リスクを下げる
    const TTL_SECS: u64 = 24 * 60 * 60;
    let mut rd = match tokio::fs::read_dir(dir).await {
        Ok(r) => r,
        Err(_) => return,
    };
    let now = std::time::SystemTime::now();
    while let Ok(Some(entry)) = rd.next_entry().await {
        let path = entry.path();
        let Ok(meta) = entry.metadata().await else {
            continue;
        };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        let age = now.duration_since(modified).unwrap_or_default();
        if age.as_secs() > TTL_SECS {
            let _ = tokio::fs::remove_file(&path).await;
        }
    }
}

/// Issue #138: paste image の最大サイズ。base64 decoded で 32 MB を超える payload は拒否。
/// 一般的なクリップボード画像 (4K スクショ PNG) は 5〜15 MB 程度なので余裕を持った上限。
const MAX_PASTED_IMAGE_BYTES: usize = 32 * 1024 * 1024;

#[tauri::command]
pub async fn terminal_save_pasted_image(
    base64: String,
    mime_type: String,
) -> SavePastedImageResult {
    // Issue #138 (Security):
    //   1. base64 文字列の段階で max を超えるなら decode せずに reject (DoS / disk full 防止)
    //   2. MIME を allowlist (image/png|jpeg|webp|gif|bmp|tiff) に限定。SVG は禁止
    //   3. decoded size も二重に check (base64 padding 崩しを通った場合に備える)
    if base64.len() > MAX_PASTED_IMAGE_BYTES * 4 / 3 + 64 {
        return SavePastedImageResult {
            ok: false,
            path: None,
            error: Some("pasted image exceeds size limit (32 MB)".into()),
        };
    }
    let ext = match extension_for_mime(&mime_type) {
        Some(e) => e,
        None => {
            return SavePastedImageResult {
                ok: false,
                path: None,
                error: Some(format!(
                    "unsupported MIME type for pasted image: {mime_type}"
                )),
            };
        }
    };
    use base64::Engine;
    let bytes = match base64::engine::general_purpose::STANDARD.decode(base64.as_bytes()) {
        Ok(b) => b,
        Err(e) => {
            return SavePastedImageResult {
                ok: false,
                path: None,
                error: Some(e.to_string()),
            };
        }
    };
    if bytes.len() > MAX_PASTED_IMAGE_BYTES {
        return SavePastedImageResult {
            ok: false,
            path: None,
            error: Some("pasted image exceeds size limit (32 MB)".into()),
        };
    }
    let dir = dirs::home_dir()
        .unwrap_or_default()
        .join(".vibe-editor")
        .join("paste-images");
    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        return SavePastedImageResult {
            ok: false,
            path: None,
            error: Some(e.to_string()),
        };
    }

    // Issue #41: 古い画像を best-effort cleanup
    cleanup_old_paste_images(&dir).await;

    let name = format!("paste-{}.{ext}", uuid::Uuid::new_v4());
    let path = dir.join(&name);
    if let Err(e) = tokio::fs::write(&path, bytes).await {
        return SavePastedImageResult {
            ok: false,
            path: None,
            error: Some(e.to_string()),
        };
    }
    SavePastedImageResult {
        ok: true,
        path: Some(path.to_string_lossy().into_owned()),
        error: None,
    }
}

#[cfg(test)]
mod mime_ext_tests {
    use super::extension_for_mime;
    #[test]
    fn maps_common_image_mimes() {
        assert_eq!(extension_for_mime("image/png"), Some("png"));
        assert_eq!(extension_for_mime("image/jpeg"), Some("jpg"));
        assert_eq!(extension_for_mime("image/jpg"), Some("jpg"));
        assert_eq!(extension_for_mime("image/webp"), Some("webp"));
        assert_eq!(extension_for_mime("image/gif"), Some("gif"));
        assert_eq!(extension_for_mime("IMAGE/JPEG"), Some("jpg"));
        // Issue #138: SVG and unknown MIME are now rejected
        assert_eq!(extension_for_mime("image/svg+xml"), None);
        assert_eq!(extension_for_mime("application/x-mystery"), None);
    }
}

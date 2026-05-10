// terminal.* command — 旧 src/main/ipc/terminal.ts に対応
//
// portable-pty 経由で PTY を spawn、SessionRegistry に登録、
// terminal:data:{id} / terminal:exit:{id} イベントを emit する。

mod codex_instructions;
pub(crate) mod command_validation;
mod paste_image;

use crate::pty::{spawn_session, SpawnOptions, UserWriteOutcome};
use crate::state::AppState;
use crate::team_hub::inject::build_chunks;
use crate::util::log_redact::redact_home;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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
    /// Issue #285 follow-up: attach 経路で renderer に渡す既存 PTY の直近出力 snapshot。
    /// HMR remount / Canvas/IDE 切替で xterm が新規生成されると banner / prompt は既に
    /// emit 済みで listener には届かないため、直前 64 KiB を文字列で同梱して replay させる。
    /// 新規 spawn 経路や attach 不発 (snapshot 空) では None。
    pub replay: Option<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SavePastedImageResult {
    pub ok: bool,
    pub path: Option<String>,
    pub error: Option<String>,
}

fn resolve_command(command: Option<String>, args: Option<Vec<String>>) -> (String, Vec<String>) {
    command_validation::normalize_terminal_command(command, args)
}

/// Issue #607 (security): args に含まれる `--resume <id>` / `--resume=<id>` を validate して
/// 不正な id を含むペアは strip + warn する defense-in-depth ヘルパー。
///
/// renderer (CardFrame / TerminalCard / use-team-launch-helpers / settings.claudeArgs) から
/// 直接 args に積まれた `--resume <id>` も、構造化フィールド `opts.resume_session_id` と同じ
/// `^[A-Za-z0-9_-]{8,64}$` 規則で守る。`--resume=<id>` の単一要素形式は 2 要素分離原則
/// (`Command::arg("--resume").arg(&id)`) を破るため常に strip する。
///
/// 戻り値は filtered な args (Vec<String>) で、warn log は内部で発行済み。
/// 入力が空または `--resume` を含まなければ no-op。
fn filter_resume_args_in_place(args: Vec<String>) -> Vec<String> {
    if args.is_empty() {
        return args;
    }
    let mut out: Vec<String> = Vec::with_capacity(args.len());
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        if arg == "--resume" {
            // 2 要素形式: 次の要素を validate
            match iter.next() {
                Some(id) if command_validation::is_valid_resume_session_id(&id) => {
                    out.push(arg);
                    out.push(id);
                }
                Some(bad) => {
                    let preview: String = bad.chars().take(16).collect();
                    tracing::warn!(
                        "[terminal] --resume id in args rejected by validator (len={}, preview={:?}), stripping pair",
                        bad.len(),
                        preview
                    );
                }
                None => {
                    tracing::warn!(
                        "[terminal] trailing --resume with no following id, stripping"
                    );
                }
            }
        } else if let Some(rest) = arg.strip_prefix("--resume=") {
            // 単一要素形式 `--resume=<id>` は 2 要素分離原則を破るため、id の中身に関わらず
            // 常に strip する。攻撃成立条件 (Claude CLI 側の parse 仕様) に依存しない厳しめの方針。
            let preview: String = rest.chars().take(16).collect();
            tracing::warn!(
                "[terminal] --resume=<id> single-element form rejected (len={}, preview={:?}), stripping",
                rest.len(),
                preview
            );
        } else {
            out.push(arg);
        }
    }
    out
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
    let Some(session) = registry.get(&term_id) else {
        return;
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

#[tauri::command]
pub async fn terminal_create(
    app: AppHandle,
    state: State<'_, AppState>,
    opts: TerminalCreateOptions,
) -> crate::commands::error::CommandResult<TerminalCreateResult> {
    let spawned_at = std::time::SystemTime::now();
    let (command, mut args) = resolve_command(opts.command, opts.args);
    if !command_validation::is_allowed_terminal_command(&command) {
        return Ok(TerminalCreateResult {
            ok: false,
            error: Some(format!("command is not allowed: {command}")),
            ..Default::default()
        });
    }
    if let Some(reason) = command_validation::reject_immediate_exec_args(&command, &args) {
        return Ok(TerminalCreateResult {
            ok: false,
            error: Some(reason.to_string()),
            ..Default::default()
        });
    }
    let is_codex_command = command_validation::is_codex_command(&command);

    // Issue #607 (security): Claude `--resume <id>` に渡される session id は renderer
    // (CardFrame / TerminalCard / use-team-launch-helpers) が `args.push("--resume", id)`
    // で直接積んでくる。id は `~/.claude/projects/<encoded>/<id>.jsonl` の file_stem や
    // zustand persist の `team-history.json` 由来で信頼境界の外にあるため、`-` 始まりの
    // 「フラグ風」文字列や shell metachar / 改行を含む id を埋められると引数注入や parse
    // 破壊が成立する恐れがある。
    //
    // ここで args に含まれる `--resume <id>` / `--resume=<id>` をスキャンし、
    // `^[A-Za-z0-9_-]{8,64}$` を満たさない id を含むペアは strip + warn で audit log に
    // 残す (新規起動にフォールバック / UX 維持)。`--resume=<id>` の単一要素形式は
    // 2 要素分離原則を破るため id 内容に関わらず常に strip。
    args = filter_resume_args_in_place(args);

    // Issue #271: HMR remount 経路では renderer 側 hook が `attachIfExists: true` を立て、
    // 既存 PTY に bind し直したいシグナルを送る。allowlist / immediate-exec チェックを通った
    // 後・コマンドラインを組み立てる前 (codex 一時ファイル作成より前) に preflight して、
    // 同じ session_key / agent_id の生存 PTY があれば spawn せず既存 id をそのまま返す。
    //
    // Issue #605 (Security): `opts.team_id` を find_attach_target に渡し、attach 候補の
    // SessionHandle.team_id と一致しない場合は attach せず通常 spawn にフォールバックする。
    // session_key / agent_id 文字列一致だけで attach を許すと、別 team の同名 agent_id 経由で
    // PTY scrollback (Claude Code prompt / API キー / git diff / ファイル内容) を吸い出す
    // 情報漏洩経路になる。
    if opts.attach_if_exists {
        if let Some(existing_id) = state.pty_registry.find_attach_target(
            opts.session_key.as_deref(),
            opts.agent_id.as_deref(),
            opts.team_id.as_deref(),
        ) {
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
            // Issue #285 follow-up: 既存 PTY の scrollback snapshot を取り出して renderer に
            // 同梱する。新しい xterm はこれを最初に書き込むことで banner / prompt が
            // 復元され、attach 直後の空白問題が解消される。SessionHandle が registry から
            // 既に消えているレース (worker thread の exit watcher が remove した直後など) では
            // None を返して replay をスキップする。
            let replay = state
                .pty_registry
                .get(&existing_id)
                .and_then(|h| h.scrollback_snapshot());
            return Ok(TerminalCreateResult {
                ok: true,
                id: Some(existing_id),
                command: Some(cmdline),
                attached: Some(true),
                replay,
                ..Default::default()
            });
        }
    }

    // Issue #293: 新規 spawn 経路は DoS ガードを通す。
    // - 同時 PTY 数が `MAX_CONCURRENT_PTY` (=100) に達していたら拒否
    // - `RATE_LIMIT_WINDOW` (=1s) 内に `MAX_PTY_SPAWNS_PER_WINDOW` (=10) 回以上 spawn 済なら拒否
    // attach_if_exists で既存 PTY を再利用する経路は新規 spawn ではないので、ここに到達しない。
    if let Err(gate_err) = state.pty_registry.try_reserve_spawn_slot() {
        let msg = gate_err.message();
        tracing::warn!("[terminal] spawn rejected by DoS gate: {msg}");
        return Ok(TerminalCreateResult {
            ok: false,
            error: Some(msg),
            ..Default::default()
        });
    }

    let (cwd, warning) =
        crate::pty::session::resolve_valid_cwd(&opts.cwd, opts.fallback_cwd.as_deref());
    if is_codex_command {
        crate::pty::codex_broker::cleanup_stale_for_cwd(&cwd);
    }

    // Issue #413: codex かつ instructions ありの場合は、
    // (A) 一時ファイル化して `--config model_instructions_file=<path>` を args に追加する経路を最優先で使う。
    //     最新 Codex CLI はこれだけで system prompt が反映される。
    // (B) 一時ファイル作成に失敗したときだけ、起動後の PTY 直接注入 fallback に回す。
    //     旧実装は (A) と (B) を常に同時実行していたため、最新 CLI で system prompt が
    //     入力欄に文字列として流れ込む二重発動バグが発生していた (Issue #413)。
    //     team_hub::inject::build_chunks を共有することで、注入が必要な経路でも
    //     ConPTY-safe (64B / 15ms チャンク + UTF-8 境界保護) な書き込み挙動を維持する。
    let codex_instructions_for_inject: Option<String> = if is_codex_command {
        if let Some(instr) = opts
            .codex_instructions
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            match codex_instructions::prepare_codex_instructions_file(instr).await {
                Some(path) => {
                    let path_str = path.to_string_lossy().into_owned();
                    tracing::info!("[terminal] codex system prompt route=cli_args path={path_str}");
                    args.push("--config".to_string());
                    args.push(format!("model_instructions_file={path_str}"));
                    None
                }
                None => {
                    tracing::warn!(
                        "[terminal] codex system prompt route=pty_inject (model_instructions_file temp write failed, falling back to direct PTY injection)"
                    );
                    Some(instr.to_string())
                }
            }
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
    tracing::debug!("[IPC] terminal_create (verbose) args={args:?} cwd={cwd}");

    if let Some(w) = &warning {
        tracing::warn!("[terminal] {w}");
    }

    // Issue #285: renderer が指定した id があれば採用 (event 名 `terminal:data:{id}` に
    // 安全な文字種だけ通す)。`attach_if_exists` 経路は preflight で既に return 済みで、
    // ここに到達するのは「新規 spawn 経路」だけなので、両者は構造的に直交している。
    // 不正値・未指定は UUID v4 にフォールバック。
    //
    // Issue #292: 衝突検出は registry の `insert_if_absent` に atomic で委ねる。
    // 旧実装の preflight `state.pty_registry.get(s).is_some()` → spawn → insert は、
    // 判定と挿入の間に Mutex を一度離すため TOCTOU race が残っていた (UUID v4 の
    // 122-bit エントロピーで実発生確率はほぼ 0 だが構造的に穴)。renderer-supplied id の
    // 形式バリデーションのみここで行い、registry 衝突確認は spawn 後の atomic 検出に任せる。
    let initial_id = match opts.id.as_deref() {
        Some(s) if !command_validation::is_valid_terminal_id(s) => {
            tracing::warn!(
                "[terminal] renderer-supplied id rejected (invalid charset/length), falling back to UUID v4"
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
        is_codex: is_codex_command,
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

    // Issue #292: id 衝突時の retry 上限。実発生はほぼ皆無 (UUID v4 衝突は
    // 122-bit エントロピー + 同時 spawn 競合) なので 3 回もあれば十分。
    const MAX_ID_ATTEMPTS: usize = 3;
    let mut id_candidate = initial_id;
    let mut attempt = 0usize;
    let adopt_id_result: Result<String, anyhow::Error> = loop {
        attempt += 1;
        match spawn_session(
            app.clone(),
            id_candidate.clone(),
            spawn_opts.clone(),
            state.pty_registry.clone(),
        ) {
            Ok(handle) => match state
                .pty_registry
                .insert_if_absent(id_candidate.clone(), handle)
            {
                Ok(()) => break Ok(id_candidate),
                Err(returned_handle) => {
                    let _ = returned_handle.kill();
                    if attempt >= MAX_ID_ATTEMPTS {
                        break Err(anyhow::anyhow!(
                            "terminal_create failed: id collision persisted after {attempt} attempts"
                        ));
                    }
                    tracing::warn!(
                        "[terminal] id {id_candidate} collided in registry (attempt {attempt}/{MAX_ID_ATTEMPTS}), retrying with fresh UUID"
                    );
                    id_candidate = Uuid::new_v4().to_string();
                }
            },
            Err(e) => break Err(e),
        }
    };

    match adopt_id_result {
        Ok(id) => {
            // 後続処理: spawn_session の Ok 分岐内で行っていた処理を保持
            // (id は registry に登録済み、retry を経た場合も Ok(()) 後の状態は insert と等価)。

            // Issue #413: Fallback 経路として PTY 直接注入する。
            // 通常は CLI args 経路 (--config model_instructions_file=) で system prompt が届くため
            // ここに到達するのは prepare_codex_instructions_file が None を返したケース (temp file
            // 作成失敗) のみ。Some の場合は既に args に追加済みで codex_instructions_for_inject は
            // None になっており、この block はスキップされる。
            // - 1.8 秒待ってから注入 (TUI の初期化 / banner 描画完了を待つ目安)。早すぎると Codex の
            //   入力欄がまだ準備できておらず文字が捨てられる。
            // - 注入は非同期 task で行い terminal_create のレスポンスはブロックしない。
            // - チームメッセージと同じ build_chunks (64B/15ms, UTF-8 境界保護) を使う。
            if let Some(instr) = codex_instructions_for_inject {
                let registry = state.pty_registry.clone();
                let term_id = id.clone();
                // Issue #630: tracker.spawn() で計上することで、CloseRequested handler が
                // wait_idle(3s) で in-flight 完了を待ってから kill_all() できるようにする。
                state.pty_inflight.spawn(async move {
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
                crate::pty::claude_watcher::spawn_watcher(
                    app.clone(),
                    watcher_id.clone(),
                    actual_root,
                    spawned_at,
                    move || registry.get(&watcher_id).is_some(),
                );
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
                // Issue #285 follow-up: 新規 spawn では replay すべき過去出力は無いので None。
                replay: None,
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
) -> crate::commands::error::CommandResult<()> {
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
) -> crate::commands::error::CommandResult<()> {
    if let Some(s) = state.pty_registry.get(&id) {
        // resize 失敗は無害なので握りつぶす (旧実装と同じ)
        let _ = s.resize(
            cols.min(u32::from(u16::MAX)) as u16,
            rows.min(u32::from(u16::MAX)) as u16,
        );
    }
    Ok(())
}

#[tauri::command]
pub async fn terminal_kill(
    state: State<'_, AppState>,
    id: String,
) -> crate::commands::error::CommandResult<()> {
    if let Some(s) = state.pty_registry.remove(&id) {
        let _ = s.kill();
    }
    Ok(())
}

/// Issue #40 / #138: paste image を `~/.vibe-editor/paste-images/` に保存する Tauri IPC。
/// 本体は `paste_image::save` に委譲 (Phase 3 / Issue #373)。
#[tauri::command]
pub async fn terminal_save_pasted_image(
    base64: String,
    mime_type: String,
) -> SavePastedImageResult {
    paste_image::save(base64, mime_type).await
}

#[cfg(test)]
mod resume_args_filter_tests {
    use super::filter_resume_args_in_place;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn keeps_valid_resume_pair() {
        let input = s(&["--resume", "550e8400-e29b-41d4-a716-446655440000"]);
        let out = filter_resume_args_in_place(input.clone());
        assert_eq!(out, input);
    }

    #[test]
    fn keeps_valid_resume_pair_among_other_args() {
        let input = s(&[
            "--dangerously-skip-permissions",
            "--resume",
            "abcdef12-3456-7890-abcd-ef1234567890",
            "--append-system-prompt",
            "you are a helper",
        ]);
        let out = filter_resume_args_in_place(input.clone());
        assert_eq!(out, input);
    }

    #[test]
    fn strips_invalid_resume_id_starting_with_dash() {
        // `-c` / `-rf` / `--print=...` のような「フラグ風」id は引数注入の主経路。
        let input = s(&["--resume", "--print=/etc/passwd"]);
        let out = filter_resume_args_in_place(input);
        assert!(out.is_empty(), "expected pair to be stripped, got {out:?}");
    }

    #[test]
    fn strips_invalid_resume_id_with_shell_metachars() {
        let input = s(&[
            "--dangerously-skip-permissions",
            "--resume",
            "abc;rm -rf /",
            "--append-system-prompt",
            "trailing arg",
        ]);
        let out = filter_resume_args_in_place(input);
        assert_eq!(
            out,
            s(&[
                "--dangerously-skip-permissions",
                "--append-system-prompt",
                "trailing arg",
            ])
        );
    }

    #[test]
    fn strips_invalid_resume_id_with_newline() {
        let input = s(&["--resume", "line1\nline2-extra"]);
        let out = filter_resume_args_in_place(input);
        assert!(out.is_empty());
    }

    #[test]
    fn strips_overlength_resume_id() {
        let bad = "a".repeat(65);
        let input = s(&["--resume", &bad]);
        let out = filter_resume_args_in_place(input);
        assert!(out.is_empty());
    }

    #[test]
    fn strips_too_short_resume_id() {
        let input = s(&["--resume", "abc"]);
        let out = filter_resume_args_in_place(input);
        assert!(out.is_empty());
    }

    #[test]
    fn strips_empty_resume_id() {
        let input = s(&["--resume", ""]);
        let out = filter_resume_args_in_place(input);
        assert!(out.is_empty());
    }

    #[test]
    fn strips_trailing_resume_with_no_id() {
        let input = s(&["--dangerously-skip-permissions", "--resume"]);
        let out = filter_resume_args_in_place(input);
        assert_eq!(out, s(&["--dangerously-skip-permissions"]));
    }

    #[test]
    fn strips_single_element_resume_equals_form() {
        // `--resume=<id>` は 2 要素分離原則を破るため id 内容に関わらず常に strip。
        let input = s(&["--resume=550e8400-e29b-41d4-a716-446655440000"]);
        let out = filter_resume_args_in_place(input);
        assert!(out.is_empty());
    }

    #[test]
    fn strips_single_element_resume_equals_with_injection() {
        let input = s(&[
            "--dangerously-skip-permissions",
            "--resume=--print=/etc/passwd",
            "tail",
        ]);
        let out = filter_resume_args_in_place(input);
        assert_eq!(out, s(&["--dangerously-skip-permissions", "tail"]));
    }

    #[test]
    fn does_not_touch_non_resume_args() {
        let input = s(&[
            "--dangerously-skip-permissions",
            "--append-system-prompt",
            "you are a helper; rm -rf /",
            "--config",
            "model_instructions_file=C:\\Users\\zooyo\\.vibe-editor\\instr.md",
        ]);
        let out = filter_resume_args_in_place(input.clone());
        assert_eq!(out, input);
    }

    #[test]
    fn handles_empty_args() {
        let out = filter_resume_args_in_place(Vec::new());
        assert!(out.is_empty());
    }

    #[test]
    fn handles_multiple_resume_pairs_keeping_valid_only() {
        let input = s(&[
            "--resume",
            "first-valid-uuid-1234",
            "--resume",
            "; rm -rf /",
            "--resume",
            "second-valid-uuid-5678",
        ]);
        let out = filter_resume_args_in_place(input);
        assert_eq!(
            out,
            s(&[
                "--resume",
                "first-valid-uuid-1234",
                "--resume",
                "second-valid-uuid-5678",
            ])
        );
    }
}

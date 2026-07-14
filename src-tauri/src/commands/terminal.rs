// terminal.* command — 旧 src/main/ipc/terminal.ts に対応
//
// portable-pty 経由で PTY を spawn、SessionRegistry に登録、
// terminal:data:{id} / terminal:exit:{id} イベントを emit する。

mod blocking_spawn;
mod codex_prompt;
pub(crate) mod command_validation;
mod paste_image;
mod prompt_files;
pub(crate) mod shell_policy;

use crate::pty::session::TerminalWarning;
use crate::pty::{SpawnOptions, UserWriteOutcome};
use crate::state::AppState;
use crate::util::log_redact::redact_home;
use codex_prompt::inject_codex_prompt_to_pty;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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
    pub claude_instructions: Option<String>,
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
    /// Issue #818: warning を structured (i18n key + params) で返す。renderer 側で
    /// `t(messageKey, params)` 評価。旧実装は日本語ハードコード String を返していた。
    pub warning: Option<TerminalWarning>,
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
                    tracing::warn!("[terminal] trailing --resume with no following id, stripping");
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

/// Issue #607 / #855 (security): Codex の `resume <id>` サブコマンド経路にも #607 と同じ
/// session id バリデーションを適用する defense-in-depth ヘルパー。
///
/// renderer (use-team-launch-helpers / CardFrame / TerminalCard) は capture-then-resume で
/// args 先頭に `resume <id>` を積む。この id は Codex rollout の payload.id
/// (`~/.codex/sessions/**/rollout-*.jsonl`) や `terminal-tabs.json` の sessionId 由来で信頼境界の
/// 外にあるため、`^[A-Za-z0-9_-]{8,64}$` を満たさない id を含む `resume <id>` ペアは strip + warn
/// して新規 Codex 起動にフォールバックする (`--resume` 用 `filter_resume_args_in_place` と同方針)。
///
/// Codex の `resume` は **先頭 positional サブコマンド** なので `args[0] == "resume"` のときだけ
/// `args[1]` を検証する。renderer の capture-then-resume が積むのは常に valid な session id
/// なので、それ以外 (信頼境界外の不正 id / `--print=...` 等のフラグ風文字列) は `resume <id>` を
/// strip して新規 Codex 起動にフォールバックする。`is_codex == false` なら no-op。
fn filter_codex_resume_id_in_place(is_codex: bool, args: Vec<String>) -> Vec<String> {
    if !is_codex || args.first().map(String::as_str) != Some("resume") {
        return args;
    }
    match args.get(1) {
        // 正常な session id (= 我々が積む値) はそのまま通す。
        Some(id) if command_validation::is_valid_resume_session_id(id) => args,
        // それ以外 (不正 id / フラグ風文字列) は `resume <bad>` を strip して新規起動に倒す
        // (#607 の `--resume` strip と同方針の defense-in-depth)。
        Some(bad) => {
            let preview: String = bad.chars().take(16).collect();
            tracing::warn!(
                "[terminal] codex `resume <id>` rejected by validator (len={}, preview={:?}), stripping subcommand",
                bad.len(),
                preview
            );
            args.into_iter().skip(2).collect()
        }
        // `resume` のみで id 無し → strip。
        None => {
            tracing::warn!("[terminal] codex `resume` with no following id, stripping subcommand");
            args.into_iter().skip(1).collect()
        }
    }
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
    // Issue #933: シェルは対話セッション起動のみ許可 (allowlist 契約 / shell_policy.rs)
    let registered = shell_policy::settings_registered_command_lines();
    if let Some(reason) =
        shell_policy::reject_non_interactive_shell_args(&command, &args, &registered)
    {
        return Ok(TerminalCreateResult {
            ok: false,
            error: Some(reason),
            ..Default::default()
        });
    }
    let sanctioned_flags = command_validation::settings_sanctioned_danger_flags(&command);
    if let Some(reason) = command_validation::reject_danger_flags(&args, &sanctioned_flags) {
        return Ok(TerminalCreateResult {
            ok: false,
            error: Some(reason),
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

    // Issue #855 (security): Codex の `resume <id>` サブコマンド経路 (renderer の capture-then-resume)
    // にも #607 と同じ `^[A-Za-z0-9_-]{8,64}$` 検証を適用し、信頼境界外の id (rollout payload.id /
    // terminal-tabs.json) を strip + warn する。不正時は新規 Codex 起動にフォールバック。
    args = filter_codex_resume_id_in_place(is_codex_command, args);

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
        let cleanup_cwd = cwd.clone();
        if let Err(error) = tokio::task::spawn_blocking(move || {
            crate::pty::codex_broker::cleanup_stale_for_cwd(&cleanup_cwd);
        })
        .await
        {
            tracing::warn!("[terminal] Codex stale cleanup task failed: {error}");
        }
    }

    if !is_codex_command {
        if let Some(prompt) = opts
            .claude_instructions
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            match prompt_files::prepare_claude_append_system_prompt_file(prompt).await {
                Some(path) => {
                    let path_str = path.to_string_lossy().into_owned();
                    tracing::info!(
                        "[terminal] claude system prompt route=cli_file path={}",
                        redact_home(&path_str)
                    );
                    args.push("--append-system-prompt-file".to_string());
                    args.push(path_str);
                }
                None => {
                    return Ok(TerminalCreateResult {
                        ok: false,
                        error: Some("failed to prepare Claude system prompt file".to_string()),
                        ..Default::default()
                    });
                }
            }
        }
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
            match prompt_files::prepare_codex_instructions_file(instr).await {
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

    // Issue #818: warning は構造化 (i18n key + params) で renderer に渡す。
    // ログには日本語/英語に依存しない key + params をそのまま記録する。
    if let Some(w) = &warning {
        tracing::warn!(
            "[terminal] cwd warning key={} params={:?}",
            w.message_key,
            w.params
        );
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
    // Issue #889: renderer (信頼境界外) 由来の env は VIBE_* のみ許可。
    // NODE_OPTIONS / LD_PRELOAD 等の注入による command allowlist 迂回を遮断する。
    // この直後に Rust が信頼境界内で insert する VIBE_TEAM_* / VIBE_AGENT_ID と、
    // spawn 側の TERM/COLORTERM 注入には影響しない。
    env.retain(|k, _| crate::pty::session::env_allowlist::is_safe_renderer_env_key(k));
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
        if let Some(mode) =
            crate::team_hub::delivery_mode::DeliveryMode::from_env().env_value_for_child()
        {
            env.insert("VIBE_TEAM_DELIVERY_MODE".into(), mode.to_string());
        }
    }

    let prepare_codex_app_server = crate::pty::codex_app_server::should_prepare_for_terminal(
        is_codex_command,
        opts.team_id.as_deref(),
        opts.agent_id.as_deref(),
    );

    // Issue #1200: resume が返した cwd と spawn の check-to-use gap を塞ぐ。cwd が
    // active / workspace root と同一 directory を指す場合のみ、TTL キャッシュを使わず
    // platform identity を再照合し、置換されていれば起動しない (fail-closed)。
    if let Err(error) = crate::commands::authz::assert_spawn_cwd_identity(
        &state.project_root,
        &state.project_root_identity,
        &cwd,
    )
    .await
    {
        return Ok(TerminalCreateResult {
            ok: false,
            error: Some(format!("spawn cwd authorization failed: {error}")),
            ..Default::default()
        });
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

    let adopt_id_result = blocking_spawn::spawn_and_register(
        app.clone(),
        initial_id,
        spawn_opts,
        state.pty_registry.clone(),
    )
    .await;

    match adopt_id_result {
        Ok(id) => {
            // 後続処理: spawn_session の Ok 分岐内で行っていた処理を保持
            // (id は registry に登録済み、retry を経た場合も Ok(()) 後の状態は insert と等価)。
            if prepare_codex_app_server {
                crate::pty::codex_app_server::spawn_prepare_task(
                    &state.pty_inflight,
                    state.pty_registry.clone(),
                    id.clone(),
                    command.clone(),
                );
            }

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
            // Claude Code / Codex 起動時に session watcher を仕掛ける。
            //   - Claude: `~/.claude/projects/<encoded>/<uuid>.jsonl` を監視 (claude_watcher)
            //   - Codex (#855): `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` を監視 (codex_watcher)
            // どちらも session id を後追いで検出し `terminal:sessionId:{id}` を emit する。
            let is_claude_command = command.to_lowercase().contains("claude");
            if is_claude_command || is_codex_command {
                let watcher_id = id.clone();
                // Issue #739: ArcSwapOption の lock-free load で現在値を読む。
                let watcher_root =
                    crate::state::current_project_root(&state.project_root).unwrap_or_default();
                let actual_root = if watcher_root.is_empty() {
                    // PTY spawn 時の cwd を流用
                    std::env::current_dir()
                        .map(|p| p.to_string_lossy().into_owned())
                        .unwrap_or_default()
                } else {
                    watcher_root
                };
                // Issue #632: SessionHandle が公開する watcher_cancel token を渡す。
                // PTY が `kill()` / `Drop` で寿命終了した瞬間に flip され、watcher は
                // 100ms 以内に exit する。registry.get(...).is_some() を 500ms ごとに
                // polling していた旧実装より反応が早く、cleanup の遅延を解消する。
                if let Some(handle) = state.pty_registry.get(&watcher_id) {
                    let cancel = handle.watcher_cancel_token();
                    if is_codex_command {
                        crate::pty::codex_watcher::spawn_watcher(
                            app.clone(),
                            state.pty_registry.clone(),
                            watcher_id,
                            actual_root,
                            spawned_at,
                            cancel,
                        );
                    } else {
                        crate::pty::claude_watcher::spawn_watcher(
                            app.clone(),
                            watcher_id,
                            actual_root,
                            spawned_at,
                            cancel,
                        );
                    }
                } else {
                    // insert 直後に外部から remove されるレース。watcher を起こす意味は無い。
                    tracing::debug!(
                        "[terminal] session {watcher_id} disappeared before session watcher spawn"
                    );
                }
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
        let data_len = data.len();
        let data_bytes = data.into_bytes();
        let outcome = tokio::task::spawn_blocking(move || s.user_write(&data_bytes))
            .await
            .map_err(|e| format!("[terminal] terminal_write spawn_blocking failed for {id}: {e}"))?
            .map_err(|e| e.to_string())?;
        match outcome {
            UserWriteOutcome::Written | UserWriteOutcome::SuppressedInjecting => {}
            UserWriteOutcome::DroppedTooLarge => {
                tracing::warn!(
                    "[terminal] dropped oversized terminal_write payload for {id}: {} bytes",
                    data_len
                );
            }
            UserWriteOutcome::DroppedRateLimited => {
                tracing::warn!(
                    "[terminal] rate-limited terminal_write for {id}: {} bytes",
                    data_len
                );
            }
        }
    }
    Ok(())
}

/// Issue #1076: `terminal_resize` の下限クランプ値。spawn 経路 (`session/spawn.rs` の
/// `openpty` で `cols.max(20)` / `rows.max(5)`) と揃える。
///
/// 通常は renderer 側の grid 計算が min 20x5 にクランプするため 0x0 resize は顕在化し
/// にくいが、信頼境界外 (renderer の任意 invoke / 将来の別 caller) から `cols=0` / `rows=0`
/// が来ると `PtySize { rows: 0, cols: 0 }` がそのまま portable-pty / ConPTY に渡り、
/// 再描画破綻やクラッシュ気味挙動を招きうる。defense-in-depth で Rust 側にも下限を持つ。
const TERMINAL_RESIZE_MIN_COLS: u16 = 20;
const TERMINAL_RESIZE_MIN_ROWS: u16 = 5;

/// renderer から来た任意の `cols` / `rows` を ConPTY に渡せる安全な範囲 (下限 20x5、
/// 上限 `u16::MAX`) にクランプする。純粋関数として切り出して回帰テスト可能にする (#1076)。
fn clamp_terminal_resize(cols: u32, rows: u32) -> (u16, u16) {
    let cols = cols.clamp(u32::from(TERMINAL_RESIZE_MIN_COLS), u32::from(u16::MAX)) as u16;
    let rows = rows.clamp(u32::from(TERMINAL_RESIZE_MIN_ROWS), u32::from(u16::MAX)) as u16;
    (cols, rows)
}

#[tauri::command]
pub async fn terminal_resize(
    state: State<'_, AppState>,
    id: String,
    cols: u32,
    rows: u32,
) -> crate::commands::error::CommandResult<()> {
    if let Some(s) = state.pty_registry.get(&id) {
        // Issue #1076: 上限 (u16::MAX) だけでなく下限 (20x5) もクランプし、0x0 等の
        // 退行サイズが ConPTY に到達しないようにする。spawn 経路の下限と対称。
        let (cols, rows) = clamp_terminal_resize(cols, rows);
        // resize 失敗は無害なので握りつぶす (旧実装と同じ)
        match tokio::task::spawn_blocking(move || s.resize(cols, rows)).await {
            Ok(Ok(())) | Ok(Err(_)) => {}
            Err(e) => {
                tracing::warn!("[terminal] terminal_resize spawn_blocking failed for {id}: {e}");
            }
        }
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

#[cfg(test)]
mod codex_resume_filter_tests {
    use super::filter_codex_resume_id_in_place;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn keeps_valid_codex_resume_id() {
        let input = s(&["resume", "019b6cec-e0fc-7d32-a4d0-a59cb61ae601"]);
        let out = filter_codex_resume_id_in_place(true, input.clone());
        assert_eq!(out, input);
    }

    #[test]
    fn keeps_valid_codex_resume_id_with_trailing_flags() {
        let input = s(&[
            "resume",
            "019b6cec-e0fc-7d32-a4d0-a59cb61ae601",
            "-c",
            "disable_paste_burst=true",
        ]);
        let out = filter_codex_resume_id_in_place(true, input.clone());
        assert_eq!(out, input);
    }

    #[test]
    fn strips_flagish_injection_id_and_keeps_trailing_args() {
        // 信頼境界外の `--print=...` 等のフラグ風 id は strip し、後続 codexArgs を残して新規起動。
        let input = s(&["resume", "--print=/etc/passwd", "-c", "k=v"]);
        let out = filter_codex_resume_id_in_place(true, input);
        assert_eq!(out, s(&["-c", "k=v"]));
    }

    #[test]
    fn strips_shell_metachar_codex_resume_id() {
        let input = s(&["resume", "abc;rm -rf /", "-c", "k=v"]);
        let out = filter_codex_resume_id_in_place(true, input);
        assert_eq!(out, s(&["-c", "k=v"]));
    }

    #[test]
    fn strips_too_short_positional_codex_resume_id() {
        let input = s(&["resume", "abc"]);
        let out = filter_codex_resume_id_in_place(true, input);
        assert!(out.is_empty());
    }

    #[test]
    fn strips_bare_resume_with_no_id() {
        let input = s(&["resume"]);
        let out = filter_codex_resume_id_in_place(true, input);
        assert!(out.is_empty());
    }

    #[test]
    fn noop_when_not_codex() {
        // claude 側は --resume を filter_resume_args_in_place が見るので、ここでは触らない。
        let input = s(&["resume", "abc;rm -rf /"]);
        let out = filter_codex_resume_id_in_place(false, input.clone());
        assert_eq!(out, input);
    }

    #[test]
    fn noop_when_resume_not_first() {
        // 先頭 positional でない "resume" 文字列は subcommand ではないので対象外。
        let input = s(&["-c", "k=v", "resume", "abc;rm -rf /"]);
        let out = filter_codex_resume_id_in_place(true, input.clone());
        assert_eq!(out, input);
    }
}

#[cfg(test)]
mod clamp_terminal_resize_tests {
    use super::{clamp_terminal_resize, TERMINAL_RESIZE_MIN_COLS, TERMINAL_RESIZE_MIN_ROWS};

    #[test]
    fn zero_by_zero_is_clamped_to_lower_bound() {
        // Issue #1076: 信頼境界外からの 0x0 resize が下限 (20x5) にクランプされること。
        assert_eq!(
            clamp_terminal_resize(0, 0),
            (TERMINAL_RESIZE_MIN_COLS, TERMINAL_RESIZE_MIN_ROWS)
        );
    }

    #[test]
    fn below_minimum_is_clamped_up() {
        assert_eq!(
            clamp_terminal_resize(1, 1),
            (TERMINAL_RESIZE_MIN_COLS, TERMINAL_RESIZE_MIN_ROWS)
        );
        assert_eq!(
            clamp_terminal_resize(19, 4),
            (TERMINAL_RESIZE_MIN_COLS, TERMINAL_RESIZE_MIN_ROWS)
        );
    }

    #[test]
    fn at_minimum_is_unchanged() {
        assert_eq!(clamp_terminal_resize(20, 5), (20, 5));
    }

    #[test]
    fn normal_size_is_unchanged() {
        assert_eq!(clamp_terminal_resize(120, 40), (120, 40));
    }

    #[test]
    fn above_u16_max_is_clamped_down() {
        // 上限 u16::MAX クランプの回帰 (旧来の上限防御を維持していること)。
        assert_eq!(
            clamp_terminal_resize(100_000, 100_000),
            (u16::MAX, u16::MAX)
        );
    }

    #[test]
    fn mixed_axis_clamps_independently() {
        // Issue #1076 (review M1): 片側だけ下限未満でも各軸が独立にクランプされること。
        assert_eq!(clamp_terminal_resize(0, 40), (TERMINAL_RESIZE_MIN_COLS, 40));
        assert_eq!(
            clamp_terminal_resize(120, 0),
            (120, TERMINAL_RESIZE_MIN_ROWS)
        );
    }

    #[test]
    fn u16_max_boundary_is_exact() {
        // Issue #1076 (review M2): 上限ちょうど (65535) は不変、+1 (65536) は 65535 に丸まる。
        let max = u32::from(u16::MAX);
        assert_eq!(clamp_terminal_resize(max, max), (u16::MAX, u16::MAX));
        assert_eq!(
            clamp_terminal_resize(max + 1, max + 1),
            (u16::MAX, u16::MAX)
        );
    }
}

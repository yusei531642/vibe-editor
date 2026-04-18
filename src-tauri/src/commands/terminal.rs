// terminal.* command — 旧 src/main/ipc/terminal.ts に対応
//
// portable-pty 経由で PTY を spawn、SessionRegistry に登録、
// terminal:data:{id} / terminal:exit:{id} イベントを emit する。
//
// **既知の Phase 1 後半 TODO**:
// - Claude Code セッション ID watcher (~/.claude/projects/<encoded>/*.jsonl 監視)
// - Codex 用 model_instructions_file 一時書き出し
// - PATH 解決 (resolve-command 移植)

use crate::pty::{spawn_session, SpawnOptions};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::{AppHandle, State};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCreateOptions {
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
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SavePastedImageResult {
    pub ok: bool,
    pub path: Option<String>,
    pub error: Option<String>,
}

/// 旧 resolveCommand 相当の最小実装。Phase 1 では「未指定なら 'claude'」だけ。
fn resolve_command(command: Option<String>, args: Option<Vec<String>>) -> (String, Vec<String>) {
    let cmd = command
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "claude".to_string());
    (cmd, args.unwrap_or_default())
}

#[tauri::command]
pub async fn terminal_create(
    app: AppHandle,
    state: State<'_, AppState>,
    opts: TerminalCreateOptions,
) -> Result<TerminalCreateResult, String> {
    let (command, args) = resolve_command(opts.command, opts.args);
    let (cwd, warning) =
        crate::pty::session::resolve_valid_cwd(&opts.cwd, opts.fallback_cwd.as_deref());

    tracing::info!(
        "[IPC] terminal_create command={command} args={args:?} cwd={cwd} cols={} rows={}",
        opts.cols,
        opts.rows
    );

    if let Some(w) = &warning {
        tracing::warn!("[terminal] {w}");
    }

    let id = Uuid::new_v4().to_string();

    // チーム所属端末なら TeamHub の socket/token と team/agent/role を env に注入
    let mut env = opts.env.unwrap_or_default();
    if let Some(team_id) = &opts.team_id {
        let (port, token, _) = state.team_hub.info().await;
        env.insert("VIBE_TEAM_SOCKET".into(), format!("127.0.0.1:{port}"));
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
        team_id: opts.team_id,
        role: opts.role,
    };

    match spawn_session(app.clone(), id.clone(), spawn_opts) {
        Ok(handle) => {
            state.pty_registry.insert(id.clone(), handle);
            // Claude Code 起動時のみ session watcher を仕掛ける (codex は jsonl を作らない)
            if command.to_lowercase().contains("claude") {
                let registry = state.pty_registry.clone();
                let watcher_id = id.clone();
                let watcher_root = state
                    .project_root
                    .lock()
                    .ok()
                    .and_then(|g| g.clone())
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
        s.write(data.as_bytes()).map_err(|e| e.to_string())?;
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

#[tauri::command]
pub async fn terminal_save_pasted_image(
    base64: String,
    mime_type: String,
) -> SavePastedImageResult {
    use base64::Engine;
    let _ = mime_type;
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
    let name = format!("paste-{}.png", uuid::Uuid::new_v4());
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

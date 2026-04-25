// terminal.* command — 旧 src/main/ipc/terminal.ts に対応
//
// portable-pty 経由で PTY を spawn、SessionRegistry に登録、
// terminal:data:{id} / terminal:exit:{id} イベントを emit する。

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

/// Codex 用 model_instructions_file を一時パスに書き出す。
/// `~/.vibe-editor/codex-instructions/<uuid>.md` を返す。
/// 失敗しても PTY spawn 自体は止めず、warn ログだけ残して None を返す。
fn write_codex_instructions(content: &str) -> Option<std::path::PathBuf> {
    let dir = dirs::home_dir()?
        .join(".vibe-editor")
        .join("codex-instructions");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        tracing::warn!("[codex-instructions] mkdir failed: {e}");
        return None;
    }
    let path = dir.join(format!("{}.md", Uuid::new_v4()));
    if let Err(e) = std::fs::write(&path, content) {
        tracing::warn!("[codex-instructions] write failed: {e}");
        return None;
    }
    Some(path)
}

/// 過去に書き出した codex-instructions ファイルのうち 1 日以上古いものを削除。
/// PTY 終了時の cleanup は ChildKiller を kill した直後では正確に取れない (Codex
/// が PTY を握ったまま再起動するケースもある) ため、TTL ベースで掃除する。
fn cleanup_old_codex_instructions(dir: &std::path::Path) {
    const TTL_SECS: u64 = 24 * 60 * 60;
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in rd.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(modified) = meta.modified() else { continue };
        let age = now.duration_since(modified).unwrap_or_default();
        if age.as_secs() > TTL_SECS {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[tauri::command]
pub async fn terminal_create(
    app: AppHandle,
    state: State<'_, AppState>,
    opts: TerminalCreateOptions,
) -> Result<TerminalCreateResult, String> {
    let (command, mut args) = resolve_command(opts.command, opts.args);
    let (cwd, warning) =
        crate::pty::session::resolve_valid_cwd(&opts.cwd, opts.fallback_cwd.as_deref());

    // Codex の team プロンプト: 一時ファイル化して `-c model_instructions_file=<path>`
    // を args 先頭に積む。Codex は CLI 引数経由で system instructions を直接渡せない
    // ため、ファイルに書いて -c で渡すのが唯一の経路。
    // この処理が無かったため Codex のチームメンバーは team プロンプトを完全に
    // 受け取れていなかった (TerminalCreateOptions に codex_instructions は来ていたが
    // 関数内で読まれていない不在実装だった)。
    if let Some(content) = opts
        .codex_instructions
        .as_ref()
        .filter(|s| !s.trim().is_empty())
    {
        if let Some(path) = write_codex_instructions(content) {
            // ベスト努力で古いファイルを掃除 (paste-images と同じ TTL 方式)。
            if let Some(parent) = path.parent() {
                cleanup_old_codex_instructions(parent);
            }
            // -c の値部分はクオート不要 (Codex 側で文字列パース)。
            // 先頭に積むのは、ユーザー指定の -c で上書きされるのを許すため。
            args.insert(0, format!("model_instructions_file={}", path.display()));
            args.insert(0, "-c".to_string());
        }
    }

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

/// Issue #40: mime_type から拡張子を決める。未知 mime は .png にフォールバック。
fn extension_for_mime(mime: &str) -> &'static str {
    match mime.trim().to_ascii_lowercase().as_str() {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/bmp" => "bmp",
        "image/tiff" => "tiff",
        "image/svg+xml" => "svg",
        _ => "png",
    }
}

/// Issue #41: paste-images/ 配下のうち mtime が 7 日以上古いファイルを削除。
/// paste の度に best-effort で呼ばれ、長期利用時のゴミ蓄積を防ぐ。
async fn cleanup_old_paste_images(dir: &std::path::Path) {
    const TTL_SECS: u64 = 7 * 24 * 60 * 60;
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

#[tauri::command]
pub async fn terminal_save_pasted_image(
    base64: String,
    mime_type: String,
) -> SavePastedImageResult {
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

    // Issue #40: mime から拡張子を選ぶ
    let ext = extension_for_mime(&mime_type);
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
        assert_eq!(extension_for_mime("image/png"), "png");
        assert_eq!(extension_for_mime("image/jpeg"), "jpg");
        assert_eq!(extension_for_mime("image/jpg"), "jpg");
        assert_eq!(extension_for_mime("image/webp"), "webp");
        assert_eq!(extension_for_mime("image/gif"), "gif");
        assert_eq!(extension_for_mime("IMAGE/JPEG"), "jpg");
        assert_eq!(extension_for_mime("application/x-mystery"), "png"); // fallback
    }
}

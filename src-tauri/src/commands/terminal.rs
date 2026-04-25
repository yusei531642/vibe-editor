// terminal.* command — 旧 src/main/ipc/terminal.ts に対応
//
// portable-pty 経由で PTY を spawn、SessionRegistry に登録、
// terminal:data:{id} / terminal:exit:{id} イベントを emit する。

use crate::pty::{spawn_session, SpawnOptions};
use crate::state::AppState;
use crate::team_hub::inject::build_chunks;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
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
    const TTL_SECS: u64 = 7 * 24 * 60 * 60;
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
    // build_chunks は banner 込みで分割するが、Codex 注入では banner 不要なので空文字を渡す。
    let chunks = build_chunks("", &instructions);
    if chunks.is_empty() {
        return;
    }
    let mut iter = chunks.into_iter();
    if let Some(first) = iter.next() {
        if session.write(&first).is_err() {
            return;
        }
    }
    for chunk in iter {
        sleep(Duration::from_millis(15)).await;
        if registry.get(&term_id).is_none() {
            return;
        }
        if session.write(&chunk).is_err() {
            return;
        }
    }
    sleep(Duration::from_millis(15)).await;
    let _ = session.write(b"\r");
    tracing::info!(
        "[terminal] codex prompt injected into pty {term_id} ({} bytes)",
        instructions.len()
    );
}

/// command が codex 系か判定 (パス形式や *.exe も拾う)
fn is_codex_command(command: &str) -> bool {
    let lower = command.to_ascii_lowercase();
    let basename = std::path::Path::new(&lower)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(&lower);
    basename == "codex" || basename.ends_with("-codex") || basename.starts_with("codex-")
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

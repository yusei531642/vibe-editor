// TeamHub モジュール
//
// 旧 src/main/team-hub.ts (Node.js loopback TCP + JSON-RPC) の Rust 移植版。
//
// 役割:
// - 各 Claude Code / Codex プロセスに spawn される team-bridge.js から
//   ローカル IPC (Unix domain socket / Windows named pipe) 接続を受ける
// - JSON-RPC line protocol (初期化 / tools/list / tools/call) を処理
// - team_send 等のツール呼び出しを PTY に直接 write 注入する (64B / 15ms)

pub mod bridge;
pub mod error;
// Issue #526: vibe-team の advisory file locks (worker のファイル編集衝突を warn する)。
pub mod file_locks;
pub mod inject;
pub mod protocol;
// Issue #517: 動的ロール同士の責務境界 lint (recruit / assign_task で warning 発火)。
pub mod role_lint;
pub mod state;

/// Issue #494: TeamHub 周辺の integration test を集約する test-only module。
/// `protocol::permissions` の matrix 検証等を `tests/permissions.rs` に置く。
#[cfg(test)]
mod tests;

pub use state::{
    server_log_path_for_diagnostics, set_server_log_path, CallContext, DynamicRole,
    MemberDiagnostics, RecruitAckOutcome, RoleProfileSummary, TeamInfo, TeamMessage, TeamTask,
};

use crate::pty::SessionRegistry;
use crate::team_hub::state::HubState;
use anyhow::{anyhow, Result};
#[cfg(unix)]
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
#[cfg(windows)]
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
#[cfg(unix)]
use tokio::net::UnixListener;
use tokio::sync::Mutex;

/// Issue #51: ハンドシェイクに要する最大時間。超過したら接続を切る。
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
/// Issue #168: handshake 後の idle 上限。これを超えて何も来なければ接続を切る。
/// wedged process が permit を占有して DoS しないようにするため。
const IDLE_TIMEOUT: Duration = Duration::from_secs(300);
/// Issue #168: write 側 timeout。client が peer side で TCP buffer を読まずに
/// 詰まらせると write_all が永遠に await しうるため、書き込みごとに頭打ち。
const WRITE_TIMEOUT: Duration = Duration::from_secs(15);
/// Issue #51: ハンドシェイク 1 行分の最大バイト長 (メモリ膨張防止)
const HANDSHAKE_LINE_LIMIT: usize = 1024;
/// Issue #51: 同時に保持できるクライアント数の上限
const MAX_CONCURRENT_CLIENTS: usize = 32;
/// Issue #50: 認証失敗時の固定 sleep (ブルートフォース抑制 + タイミングノイズ)
const AUTH_FAIL_DELAY: Duration = Duration::from_millis(300);
/// Issue #107: handshake 後の JSON-RPC 1 行あたりの最大バイト長。
/// localhost の信頼前提でも巨大 line を投げ続ければ Hub のメモリを使い果たせるため、
/// 上限超過は parse error を返してその行を破棄する。
pub(crate) const RPC_LINE_LIMIT: usize = 256 * 1024; // 256 KiB / line

#[cfg(unix)]
async fn ensure_private_runtime_dir(dir: &Path) -> Result<()> {
    tokio::fs::create_dir_all(dir).await?;
    use std::os::unix::fs::PermissionsExt;
    let perm = std::fs::Permissions::from_mode(0o700);
    let _ = tokio::fs::set_permissions(dir, perm).await;
    Ok(())
}

#[cfg(unix)]
async fn bind_local_listener() -> Result<(UnixListener, String)> {
    let dir = crate::util::config_paths::vibe_root().join("team-hub");
    ensure_private_runtime_dir(&dir).await?;
    let path = dir.join(format!("hub-{}.sock", std::process::id()));
    if let Ok(meta) = tokio::fs::symlink_metadata(&path).await {
        let ft = meta.file_type();
        if ft.is_dir() {
            tokio::fs::remove_dir_all(&path).await?;
        } else {
            tokio::fs::remove_file(&path).await?;
        }
    }
    let listener = UnixListener::bind(&path)?;
    use std::os::unix::fs::PermissionsExt;
    let _ = tokio::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).await;
    Ok((listener, path.to_string_lossy().into_owned()))
}

#[cfg(windows)]
fn new_pipe_endpoint() -> String {
    format!(r"\\.\pipe\vibe-editor-team-hub-{}", uuid::Uuid::new_v4())
}

#[cfg(windows)]
fn create_pipe_server(endpoint: &str, first_instance: bool) -> Result<NamedPipeServer> {
    let mut options = ServerOptions::new();
    options.reject_remote_clients(true);
    if first_instance {
        options.first_pipe_instance(true);
    }
    Ok(options.create(endpoint)?)
}

/// Issue #50: 固定長バイト列の constant-time 比較。
/// 先頭一致 prefix の長さに処理時間が依存しないようにする。
/// ※ 長さだけは leak するが、token 長は固定なので問題ない。
fn constant_time_eq_bytes(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[derive(Clone)]
pub struct TeamHub {
    pub(crate) state: Arc<Mutex<HubState>>,
    pub(crate) registry: Arc<SessionRegistry>,
    /// 任意で AppHandle を保持。`set_app_handle` で setup 後に注入する。
    /// Phase 3: protocol::team_send が `team:handoff` event を emit するために使う。
    pub(crate) app_handle: Arc<Mutex<Option<tauri::AppHandle>>>,
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

async fn handle_client<S>(hub: TeamHub, sock: S, expected_token: String) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (rd, mut wr) = tokio::io::split(sock);
    let mut reader = BufReader::new(rd);

    // Issue #51: ハンドシェイク 1 行の最大長は HANDSHAKE_LINE_LIMIT。超過したら拒否。
    //            全体を HANDSHAKE_TIMEOUT でラップして、無言接続の無限滞留を防ぐ。
    let mut hello_line = String::new();
    let read_fut = async {
        let n = reader.read_line(&mut hello_line).await?;
        if n == 0 {
            return Err(anyhow!("connection closed before handshake"));
        }
        if n > HANDSHAKE_LINE_LIMIT || hello_line.len() > HANDSHAKE_LINE_LIMIT {
            return Err(anyhow!(
                "handshake line exceeds {HANDSHAKE_LINE_LIMIT} bytes"
            ));
        }
        Ok::<_, anyhow::Error>(())
    };
    match tokio::time::timeout(HANDSHAKE_TIMEOUT, read_fut).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            tracing::debug!("[teamhub] handshake read error: {e}");
            return Ok(());
        }
        Err(_) => {
            tracing::warn!("[teamhub] handshake timeout (>{HANDSHAKE_TIMEOUT:?})");
            return Ok(());
        }
    }

    let hello: serde_json::Value =
        serde_json::from_str(hello_line.trim()).unwrap_or(serde_json::Value::Null);
    let token = hello.get("token").and_then(|v| v.as_str()).unwrap_or("");
    // Issue #50: 固定時間比較 + 認証失敗時は固定 sleep
    if !constant_time_eq_bytes(token.as_bytes(), expected_token.as_bytes()) {
        tokio::time::sleep(AUTH_FAIL_DELAY).await;
        return Ok(());
    }
    // Issue #52: agentId / teamId / role は空文字禁止。team_id は register 済みのみ許可。
    let team_id = hello.get("teamId").and_then(|v| v.as_str()).unwrap_or("");
    let role = hello.get("role").and_then(|v| v.as_str()).unwrap_or("");
    let agent_id = hello.get("agentId").and_then(|v| v.as_str()).unwrap_or("");
    if team_id.trim().is_empty() || role.trim().is_empty() || agent_id.trim().is_empty() {
        tracing::warn!(
            "[teamhub] handshake rejected: empty field (team={team_id:?} role={role:?} agent={agent_id:?})"
        );
        tokio::time::sleep(AUTH_FAIL_DELAY).await;
        return Ok(());
    }
    {
        let s = hub.state.lock().await;
        if !s.active_teams.contains(team_id) {
            tracing::warn!("[teamhub] handshake rejected: unregistered team_id {team_id:?}");
            drop(s);
            tokio::time::sleep(AUTH_FAIL_DELAY).await;
            return Ok(());
        }
    }
    let ctx = CallContext {
        team_id: team_id.to_string(),
        role: role.to_string(),
        agent_id: agent_id.to_string(),
    };
    tracing::debug!(
        "[teamhub] client authed team={} role={} agent={}",
        ctx.team_id,
        ctx.role,
        ctx.agent_id
    );
    // 待機中の team_recruit があればここで resolve (caller への MCP response が解放される)
    // Issue #183: client が予約 role と異なる role を主張していたら切断する。
    // Issue #342 Phase 2: pending の team_id 不一致も切断対象 (cross-team 偽 handshake 防御)。
    if !hub
        .resolve_pending_recruit(&ctx.agent_id, &ctx.team_id, &ctx.role)
        .await
    {
        tokio::time::sleep(AUTH_FAIL_DELAY).await;
        return Ok(());
    }

    // Issue #107 + #133: BufReader::lines() は行サイズに上限が無く DoS になる。
    // 旧実装は 1 byte ずつ read_exact を呼んでいたため、長文 message 1 行 (10 KB) で
    // 10000 回の future poll が走り tokio worker を飽和させていた。
    // → AsyncBufReadExt::read_until(b'\n', ...) でまとめ取りし、戻り値が
    //   RPC_LINE_LIMIT を超えていたらその場で破棄する方針に変更。
    //   read_until は内部 BufReader バッファごと一気にコピーするので poll 回数が激減する。
    use tokio::io::AsyncReadExt;
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    loop {
        buf.clear();
        // RPC_LINE_LIMIT + 1 までは積極的に取り、超えたら overflowed として破棄する。
        // 1 行が極端に長くてもメモリ使用量は LIMIT で頭打ちになる。
        let mut overflowed = false;
        // tokio の BufReader::read_until は max 制限が無いので、自前で take してから読む。
        // ただし client が \n を送ってこないと無限読みになるため、LIMIT+1 で take。
        let mut limited = (&mut reader).take((RPC_LINE_LIMIT as u64) + 1);
        // Issue #168: idle timeout 付きで読み込む。一定時間無音なら接続を切って
        // permit を解放し、wedged client の occupation DoS を防ぐ。
        match tokio::time::timeout(IDLE_TIMEOUT, limited.read_until(b'\n', &mut buf)).await {
            Ok(Ok(0)) => return Ok(()), // EOF / 切断
            Ok(Ok(_)) => {}
            Ok(Err(_)) => return Ok(()),
            Err(_) => {
                tracing::warn!("[teamhub] dropping idle client (no data for {IDLE_TIMEOUT:?})");
                return Ok(());
            }
        }
        if buf.last() != Some(&b'\n') {
            // limit に達して \n 未到達 → overflowed。残りを \n まで捨てる。
            overflowed = true;
            buf.clear();
            // \n を見つけるまで読み捨てる (LIMIT バイトずつ繰り返し)
            loop {
                let mut drop_buf: Vec<u8> = Vec::with_capacity(4096);
                let mut drop_limited = (&mut reader).take((RPC_LINE_LIMIT as u64) + 1);
                match drop_limited.read_until(b'\n', &mut drop_buf).await {
                    Ok(0) => return Ok(()),
                    Ok(_) => {}
                    Err(_) => return Ok(()),
                }
                if drop_buf.last() == Some(&b'\n') {
                    break;
                }
            }
        } else {
            // 末尾の \n を取り除く (後続の処理が trim 前提のため)
            buf.pop();
        }

        if overflowed {
            tracing::warn!("[teamhub] dropping RPC line: exceeded {RPC_LINE_LIMIT} bytes");
            // Issue #149: line too long の段階では req.id が読めないので、JSON-RPC 仕様上
            // notification と区別できない。仕様準拠のため error 応答を送らずに drop する。
            // 書き込み I/O 失敗で client loop ごと切断するのも避ける。
            continue;
        }

        // \r で終わっていたら除去
        if buf.last() == Some(&b'\r') {
            buf.pop();
        }
        if buf.is_empty() {
            continue;
        }
        // Issue #149: 書き込み I/O 失敗で client loop ごと終了するのを避ける。
        // ECONNRESET 等の一時的な失敗は log + continue で次の line を待つ。
        // notification (id=null) には仕様上 error を返さない。
        let Ok(line_str) = std::str::from_utf8(&buf) else {
            tracing::warn!("[teamhub] dropping invalid utf-8 line");
            continue;
        };
        let req: serde_json::Value = match serde_json::from_str(line_str) {
            Ok(v) => v,
            Err(_) => {
                tracing::warn!("[teamhub] dropping unparseable JSON line");
                continue;
            }
        };
        if let Some(resp) = protocol::handle(&hub, &ctx, &req).await {
            // Issue #168: 書き込みも WRITE_TIMEOUT 付き。peer 側が TCP recv buffer を
            // 読まずに詰まらせるケースで write_all が永遠に await するのを防ぐ。
            let body = resp.to_string();
            let write_fut = async {
                wr.write_all(body.as_bytes()).await?;
                wr.write_all(b"\n").await?;
                Ok::<(), std::io::Error>(())
            };
            match tokio::time::timeout(WRITE_TIMEOUT, write_fut).await {
                Ok(Ok(())) => {}
                Ok(Err(e)) => {
                    tracing::warn!("[teamhub] response write failed: {e}");
                    return Ok(());
                }
                Err(_) => {
                    tracing::warn!(
                        "[teamhub] dropping wedged client (write timeout {WRITE_TIMEOUT:?})"
                    );
                    return Ok(());
                }
            }
        }
    }
}

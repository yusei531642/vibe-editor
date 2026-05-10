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
// Issue #512: 32 KiB 超の payload を `<project_root>/.vibe-team/tmp/<short_id>.md` に書き出して
// inject 本文を「summary + attached: <path>」に置換する spool 機構。
pub mod spool;
pub mod state;

/// Issue #494: TeamHub 周辺の integration test を集約する test-only module。
/// `protocol::permissions` の matrix 検証等を `tests/permissions.rs` に置く。
#[cfg(test)]
mod tests;

pub use state::{
    server_log_path_for_diagnostics, set_server_log_path, CallContext, DynamicRole, EnginePolicy,
    EnginePolicyKind, MemberDiagnostics, RecruitAckOutcome, RoleProfileSummary, TeamInfo,
    TeamMessage, TeamTask,
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

// =====================================================================================
// Issue #603 (Security): Peer credential 検証 — handshake 直前に呼んで、token 一致だけで
// 成立する旧設計に「同 user の同一 UID/SID プロセスかどうか」の壁を 1 段加える。
//
// 攻撃モデル: VIBE_TEAM_TOKEN は env 経由で worker に渡され、`/proc/<pid>/environ` (Linux) /
// `Get-Process | Select StartInfo` (Windows) で同 user の他プロセスから盗み見られる。
// token 盗難で「同 user 内の任意のローカルプロセス」が Hub に接続できるのを、UID/SID 一致
// 検証で「親 vibe-editor 自身が起動した子プロセスのみ」(= 同 user) に閉じ込める。
//
// 制限: 「同 user 内の別プロセス」は引き続き Hub に到達できる (UID/SID は同じ)。
// 真の親子関係まで縛るには ANCILLARY data / DuplicateHandle 経路が必要だが、それは Wave 2 候補。
// 本実装は「別 user / sandbox 越境」を防ぐだけで、issue 本文の Tier A スコープを満たす。
// =====================================================================================

#[cfg(target_os = "linux")]
pub(crate) fn check_peer_is_self_unix(
    stream: &tokio::net::UnixStream,
) -> Result<()> {
    use std::os::fd::BorrowedFd;
    use std::os::unix::io::AsRawFd;
    // nix 0.29 の `getsockopt::<F: AsFd, _>` は raw fd (i32) を直接受け取らないため、
    // tokio UnixStream の as_raw_fd() を `BorrowedFd::borrow_raw` で wrap する。
    // BorrowedFd の lifetime は本関数内に閉じ、stream 引数より長くは生きないので
    // close-after-borrow の race は発生しない。
    let raw_fd = stream.as_raw_fd();
    let fd = unsafe { BorrowedFd::borrow_raw(raw_fd) };
    let cred = nix::sys::socket::getsockopt(&fd, nix::sys::socket::sockopt::PeerCredentials)
        .map_err(|e| anyhow!("getsockopt(SO_PEERCRED) failed: {e}"))?;
    let own_uid = nix::unistd::getuid().as_raw();
    if cred.uid() != own_uid {
        return Err(anyhow!(
            "peer uid {} != own uid {} (pid={})",
            cred.uid(),
            own_uid,
            cred.pid()
        ));
    }
    Ok(())
}

#[cfg(any(
    target_os = "macos",
    target_os = "freebsd",
    target_os = "dragonfly",
    target_os = "openbsd",
    target_os = "netbsd"
))]
pub(crate) fn check_peer_is_self_unix(
    stream: &tokio::net::UnixStream,
) -> Result<()> {
    use std::os::unix::io::AsRawFd;
    let fd = stream.as_raw_fd();
    let mut uid: libc::uid_t = 0;
    let mut gid: libc::gid_t = 0;
    let ret = unsafe { libc::getpeereid(fd, &mut uid, &mut gid) };
    if ret != 0 {
        return Err(anyhow!(
            "getpeereid failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    let own_uid = unsafe { libc::getuid() };
    if uid != own_uid {
        return Err(anyhow!("peer uid {uid} != own uid {own_uid}"));
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) fn check_peer_is_self_windows(
    pipe: &NamedPipeServer,
) -> Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, FALSE, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Security::{
        EqualSid, GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::System::Pipes::GetNamedPipeClientProcessId;
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    /// HANDLE を Drop で必ず閉じる薄い RAII guard。
    struct HandleGuard(HANDLE);
    impl Drop for HandleGuard {
        fn drop(&mut self) {
            if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
                unsafe {
                    let _ = CloseHandle(self.0);
                }
            }
        }
    }

    /// 指定 token の TokenUser SID raw bytes (size + buf) を返す。
    fn read_token_user_sid_bytes(token: HANDLE) -> Result<Vec<u8>> {
        let mut size: u32 = 0;
        // 1st pass: required size を取得 (戻り値は 0 = 失敗扱いだが ERROR_INSUFFICIENT_BUFFER で OK)
        unsafe {
            GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut size);
        }
        if size == 0 {
            return Err(anyhow!(
                "GetTokenInformation(TokenUser) size probe returned 0: {}",
                std::io::Error::last_os_error()
            ));
        }
        let mut buf: Vec<u8> = vec![0u8; size as usize];
        let ok = unsafe {
            GetTokenInformation(
                token,
                TokenUser,
                buf.as_mut_ptr() as *mut _,
                size,
                &mut size,
            )
        };
        if ok == 0 {
            return Err(anyhow!(
                "GetTokenInformation(TokenUser) failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(buf)
    }

    let pipe_handle: HANDLE = pipe.as_raw_handle() as HANDLE;
    let mut client_pid: u32 = 0;
    let ok = unsafe { GetNamedPipeClientProcessId(pipe_handle, &mut client_pid) };
    if ok == 0 {
        return Err(anyhow!(
            "GetNamedPipeClientProcessId failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    // Open client process (read-only)
    let raw_proc =
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, client_pid) };
    if raw_proc.is_null() || raw_proc == INVALID_HANDLE_VALUE {
        return Err(anyhow!(
            "OpenProcess({client_pid}, QUERY_LIMITED_INFORMATION) failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    let proc_guard = HandleGuard(raw_proc);

    // Open client token (read-only)
    let mut raw_client_token: HANDLE = std::ptr::null_mut();
    let ok =
        unsafe { OpenProcessToken(proc_guard.0, TOKEN_QUERY, &mut raw_client_token) };
    if ok == 0 {
        return Err(anyhow!(
            "OpenProcessToken(client pid={client_pid}) failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    let client_token_guard = HandleGuard(raw_client_token);
    let client_buf = read_token_user_sid_bytes(client_token_guard.0)?;
    let client_sid = unsafe { (*(client_buf.as_ptr() as *const TOKEN_USER)).User.Sid };

    // Open self token (read-only)
    let mut raw_self_token: HANDLE = std::ptr::null_mut();
    let ok = unsafe {
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw_self_token)
    };
    if ok == 0 {
        return Err(anyhow!(
            "OpenProcessToken(self) failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    let self_token_guard = HandleGuard(raw_self_token);
    let self_buf = read_token_user_sid_bytes(self_token_guard.0)?;
    let self_sid = unsafe { (*(self_buf.as_ptr() as *const TOKEN_USER)).User.Sid };

    // Compare SIDs (EqualSid: 0 = mismatch / nonzero = equal)
    let same = unsafe { EqualSid(client_sid, self_sid) };
    if same == 0 {
        return Err(anyhow!(
            "peer SID does not match own SID (client_pid={client_pid})"
        ));
    }
    Ok(())
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

    // Issue #638: handshake 後の RPC 処理は inner async block に隔離し、どの early-return path
    // (EOF / idle timeout / I/O error / write timeout) を通っても closing 後に必ず
    // `release_all_file_locks_for_agent` が走るようにする。worker process が `kill -9` 等で
    // 異常終了した場合、socket close → BufReader が EOF を返し serve_session が落ちるので、
    // dismiss MCP が呼ばれずとも advisory lock が解放される (= stale lock の自動掃除)。
    let _ = serve_session(&hub, &ctx, &mut reader, &mut wr).await;

    // Issue #638: peer 切断 hook — 当該 agent の advisory file lock を一括解放。
    // dismiss MCP 経由 (`super::protocol::tools::dismiss`) と同じ helper を呼ぶことで DRY を保つ。
    let released_lock_count = hub
        .release_all_file_locks_for_agent(&ctx.team_id, &ctx.agent_id)
        .await;
    if released_lock_count > 0 {
        tracing::info!(
            "[teamhub] released {released_lock_count} advisory file lock(s) on disconnect (team={} agent={})",
            ctx.team_id,
            ctx.agent_id
        );
    }

    Ok(())
}

/// Issue #638: handshake 後の RPC ループ本体。caller 側 (`handle_client`) で disconnect 後の
/// cleanup を一括で行えるよう、loop 内の return path を全て `Ok(())` で外側に返す。
async fn serve_session<R, W>(
    hub: &TeamHub,
    ctx: &CallContext,
    reader: &mut BufReader<R>,
    wr: &mut W,
) -> Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
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
        let mut limited = (&mut *reader).take((RPC_LINE_LIMIT as u64) + 1);
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
                let mut drop_limited = (&mut *reader).take((RPC_LINE_LIMIT as u64) + 1);
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
        if let Some(resp) = protocol::handle(hub, ctx, &req).await {
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

#[cfg(test)]
mod disconnect_release_tests {
    //! Issue #638: socket / pipe 切断 hook で advisory file lock が解放されることを保証する。
    //!
    //! `handle_client` を `tokio::io::duplex` 上で動かし、handshake 直後に client 側を drop する
    //! (= worker process が `kill -9` 等で消えた状況のシミュレーション)。client 側 EOF を受けて
    //! `serve_session` が抜けたあと、cleanup hook が `release_all_file_locks_for_agent` を呼んで
    //! 当該 agent の lock を残らず解放しているかを map から検証する。
    //!
    //! `team_dismiss` MCP 経路は protocol::tools::dismiss 側でカバーされており、本 test は
    //! 「dismiss が呼ばれない異常切断」=「socket EOF だけが手掛かり」なケースを担保する。
    use super::*;
    use crate::pty::SessionRegistry;
    use crate::team_hub::file_locks;
    use serde_json::json;
    use std::sync::Arc;
    use tokio::io::AsyncWriteExt;
    use tokio::time::{timeout, Duration};

    /// 最小限の HubState セットアップ。`register_team` は project_root の永続化 I/O を踏むので、
    /// test 中は active_teams を直接挿入し、token も既知値を直書きする。
    async fn setup_hub_for_test(team_id: &str, token: &str) -> TeamHub {
        let hub = TeamHub::new(Arc::new(SessionRegistry::new()));
        {
            let mut s = hub.state.lock().await;
            s.active_teams.insert(team_id.to_string());
            s.token = token.to_string();
        }
        hub
    }

    /// agent 用の lock を直接 map に push しておく。
    async fn pre_acquire_lock(hub: &TeamHub, team_id: &str, agent_id: &str, role: &str, path: &str) {
        let mut s = hub.state.lock().await;
        let result = file_locks::try_acquire(
            &mut s.file_locks,
            team_id,
            agent_id,
            role,
            &[path.to_string()],
        );
        assert!(!result.has_conflicts(), "pre-condition: lock must be acquirable");
        assert_eq!(result.locked.len(), 1);
    }

    async fn count_team_locks(hub: &TeamHub, team_id: &str) -> usize {
        let s = hub.state.lock().await;
        s.file_locks
            .iter()
            .filter(|((tid, _), _)| tid == team_id)
            .count()
    }

    /// kill -9 シミュレーション: handshake 完了直後に client 側を drop し、socket EOF だけで
    /// agent の advisory lock が解放されることを assert する。
    #[tokio::test]
    async fn handle_client_releases_locks_on_abrupt_disconnect() {
        let team_id = "team-638";
        let agent_id = "vc-worker-638";
        let role = "programmer";
        let token = "deadbeef-test-token";
        let hub = setup_hub_for_test(team_id, token).await;
        pre_acquire_lock(&hub, team_id, agent_id, role, "src/foo.rs").await;
        assert_eq!(count_team_locks(&hub, team_id).await, 1);

        // server <-> client 仮想 socket を duplex で繋ぐ。
        let (server_side, mut client_side) = tokio::io::duplex(8 * 1024);

        // handshake JSON を流し込む。
        let hello = json!({
            "token": token,
            "teamId": team_id,
            "role": role,
            "agentId": agent_id,
        });
        let mut hello_line = serde_json::to_vec(&hello).unwrap();
        hello_line.push(b'\n');
        client_side.write_all(&hello_line).await.unwrap();
        client_side.flush().await.unwrap();

        // server task を起動 (handle_client は serve_session 経由で disconnect cleanup まで実行)。
        let hub_clone = hub.clone();
        let server_handle = tokio::spawn(async move {
            handle_client(hub_clone, server_side, token.to_string()).await
        });

        // client 側を即時 drop = worker process が `kill -9` で死んだのと同じ状況を作る。
        drop(client_side);

        // serve_session は EOF を読んで Ok(()) を返し、cleanup hook が走る。
        // ハンドシェイクの読み込みは HANDSHAKE_TIMEOUT (5s) 以内に解決する想定なので、test 側は 10s 上限。
        timeout(Duration::from_secs(10), server_handle)
            .await
            .expect("handle_client should finish promptly after client EOF")
            .expect("server task should not panic")
            .expect("handle_client should return Ok(())");

        // 解放 hook で lock 表が空になっているはず。
        assert_eq!(
            count_team_locks(&hub, team_id).await,
            0,
            "advisory lock for disconnected agent must be released"
        );
    }

    /// 同一 agent_id で再 spawn したケースを模擬: 再接続時に handshake → 即 drop しても、
    /// 「前回の lock が掃除済み」状態なら新しい接続で取り直せる (gridlock しない)。
    #[tokio::test]
    async fn re_spawned_agent_can_acquire_after_previous_disconnect() {
        let team_id = "team-638b";
        let agent_id = "vc-worker-638b";
        let role = "programmer";
        let token = "deadbeef-test-token-b";
        let hub = setup_hub_for_test(team_id, token).await;

        // 1 回目: lock を取って disconnect。
        pre_acquire_lock(&hub, team_id, agent_id, role, "src/bar.rs").await;
        let (s1, mut c1) = tokio::io::duplex(8 * 1024);
        let hello = json!({
            "token": token,
            "teamId": team_id,
            "role": role,
            "agentId": agent_id,
        });
        let mut line = serde_json::to_vec(&hello).unwrap();
        line.push(b'\n');
        c1.write_all(&line).await.unwrap();
        c1.flush().await.unwrap();
        let h1 = {
            let hub = hub.clone();
            tokio::spawn(async move { handle_client(hub, s1, token.to_string()).await })
        };
        drop(c1);
        timeout(Duration::from_secs(10), h1)
            .await
            .expect("first session should finish")
            .expect("no panic")
            .expect("ok");

        assert_eq!(
            count_team_locks(&hub, team_id).await,
            0,
            "previous lock must be cleared for the redspawn flow"
        );

        // 2 回目: 同じ path を再取得できる (= gridlock 解消の証明)。
        let mut s = hub.state.lock().await;
        let result = file_locks::try_acquire(
            &mut s.file_locks,
            team_id,
            agent_id,
            role,
            &["src/bar.rs".to_string()],
        );
        assert!(!result.has_conflicts());
        assert_eq!(result.locked, vec!["src/bar.rs".to_string()]);
    }
}

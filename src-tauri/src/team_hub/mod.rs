// TeamHub モジュール
//
// 旧 src/main/team-hub.ts (Node.js TCP + JSON-RPC) の Rust 移植版。
//
// 役割:
// - 各 Claude Code / Codex プロセスに spawn される team-bridge.js から TCP 接続を受ける
// - JSON-RPC line protocol (初期化 / tools/list / tools/call) を処理
// - team_send 等のツール呼び出しを PTY に直接 write 注入する (64B / 15ms)

pub mod bridge;
pub mod inject;
pub mod protocol;

use crate::pty::SessionRegistry;
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex, Semaphore};

/// Issue #51: ハンドシェイクに要する最大時間。超過したら接続を切る。
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
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

struct HubState {
    /// チーム別の会話履歴・タスク
    teams: HashMap<String, TeamInfo>,
    /// アクティブな team_id (MCP 設定の参照カウント)
    active_teams: HashSet<String>,
    /// listen ポート (0 なら未起動)
    port: u16,
    /// ハンドシェイクトークン (16 進 48 文字)
    token: String,
    /// 書き出し済みの bridge スクリプトパス
    bridge_path: PathBuf,
    /// agent_id → 現在進行中の inject タスク数 (cancel 用には含めない、レート制限用)
    pending_injects: HashMap<String, usize>,
    /// agent_id → 待機中の recruit oneshot (handshake 完了で resolve)
    pending_recruits: HashMap<String, oneshot::Sender<RecruitOutcome>>,
    /// renderer から同期された role profile 一覧 (team_list_role_profiles で返す)
    role_profile_summary: Vec<RoleProfileSummary>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleProfileSummary {
    pub id: String,
    pub label_en: String,
    pub label_ja: Option<String>,
    pub description_en: String,
    pub description_ja: Option<String>,
    pub can_recruit: bool,
    pub can_dismiss: bool,
    pub can_assign_tasks: bool,
    pub default_engine: String, // "claude" | "codex"
    pub singleton: bool,
}

#[derive(Clone, Debug)]
pub struct RecruitOutcome {
    pub agent_id: String,
    pub role_profile_id: String,
}

#[derive(Default, Clone)]
pub struct TeamInfo {
    pub id: String,
    pub name: String,
    pub messages: Vec<TeamMessage>,
    pub tasks: Vec<TeamTask>,
}

#[derive(Clone)]
pub struct TeamMessage {
    pub id: u32,
    pub from: String,
    pub from_agent_id: String,
    pub to: String,
    pub message: String,
    pub timestamp: String,
    pub read_by: Vec<String>,
}

#[derive(Clone)]
pub struct TeamTask {
    pub id: u32,
    pub assigned_to: String,
    pub description: String,
    pub status: String,
    pub created_by: String,
    pub created_at: String,
}

#[derive(Clone, Debug)]
pub struct CallContext {
    pub team_id: String,
    pub role: String,
    pub agent_id: String,
}

impl TeamHub {
    pub fn new(registry: Arc<SessionRegistry>) -> Self {
        Self {
            registry,
            state: Arc::new(Mutex::new(HubState {
                teams: HashMap::new(),
                active_teams: HashSet::new(),
                port: 0,
                token: String::new(),
                bridge_path: PathBuf::new(),
                pending_injects: HashMap::new(),
                pending_recruits: HashMap::new(),
                role_profile_summary: Vec::new(),
            })),
            app_handle: Arc::new(Mutex::new(None)),
        }
    }

    /// renderer から role profile summary を同期 (team_list_role_profiles の戻り値)
    pub async fn set_role_profile_summary(&self, summary: Vec<RoleProfileSummary>) {
        let mut s = self.state.lock().await;
        s.role_profile_summary = summary;
    }

    pub async fn get_role_profile_summary(&self) -> Vec<RoleProfileSummary> {
        self.state.lock().await.role_profile_summary.clone()
    }

    /// recruit が要求された agent_id を pending に登録。handshake 完了で resolve する。
    pub async fn register_pending_recruit(
        &self,
        agent_id: String,
    ) -> oneshot::Receiver<RecruitOutcome> {
        let (tx, rx) = oneshot::channel();
        let mut s = self.state.lock().await;
        s.pending_recruits.insert(agent_id, tx);
        rx
    }

    /// handshake 内で agent_id がマッチしたら呼ぶ。recruit が待機中ならここで resolve。
    pub async fn resolve_pending_recruit(&self, agent_id: &str, role_profile_id: &str) {
        let mut s = self.state.lock().await;
        if let Some(tx) = s.pending_recruits.remove(agent_id) {
            let _ = tx.send(RecruitOutcome {
                agent_id: agent_id.to_string(),
                role_profile_id: role_profile_id.to_string(),
            });
        }
    }

    /// timeout 等でキャンセル: pending を破棄 (送信側 dropped で recv が Err になる)
    pub async fn cancel_pending_recruit(&self, agent_id: &str) {
        let mut s = self.state.lock().await;
        s.pending_recruits.remove(agent_id);
    }

    /// setup 後に AppHandle を注入 (event::emit で使う)
    pub async fn set_app_handle(&self, app: tauri::AppHandle) {
        let mut g = self.app_handle.lock().await;
        *g = Some(app);
    }

    pub async fn start(&self) -> Result<()> {
        let mut state = self.state.lock().await;
        if state.port != 0 {
            return Ok(());
        }
        // ハンドシェイクトークンを生成 (24 byte → hex 48 文字)
        use rand::RngCore;
        let mut buf = [0u8; 24];
        rand::thread_rng().fill_bytes(&mut buf);
        state.token = hex_encode(&buf);

        // bridge スクリプトを `~/.vibe-editor/team-bridge.js` に書き出し
        let dir = dirs::home_dir().unwrap_or_default().join(".vibe-editor");
        tokio::fs::create_dir_all(&dir).await?;
        let bridge_path = dir.join("team-bridge.js");
        tokio::fs::write(&bridge_path, bridge::SOURCE).await?;
        state.bridge_path = bridge_path;

        // TCP listen
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let local = listener.local_addr()?;
        state.port = local.port();
        let token = state.token.clone();
        drop(state);

        // Issue #51: 同時クライアント数を Semaphore で制限し、空きを待てない接続は即 drop
        let sem = Arc::new(Semaphore::new(MAX_CONCURRENT_CLIENTS));
        let hub = self.clone();
        tokio::spawn(async move {
            loop {
                let (sock, _) = match listener.accept().await {
                    Ok(s) => s,
                    Err(e) => {
                        tracing::warn!("teamhub accept failed: {e}");
                        continue;
                    }
                };
                // 空きを待たず try_acquire。枠が無ければ接続を即 close して攻撃耐性を上げる。
                let permit = match sem.clone().try_acquire_owned() {
                    Ok(p) => p,
                    Err(_) => {
                        tracing::warn!(
                            "[teamhub] rejecting connection: client limit ({}) reached",
                            MAX_CONCURRENT_CLIENTS
                        );
                        drop(sock);
                        continue;
                    }
                };
                let hub2 = hub.clone();
                let token = token.clone();
                tokio::spawn(async move {
                    let _permit = permit; // クライアント終了時に drop されて枠を返す
                    if let Err(e) = handle_client(hub2, sock, token).await {
                        tracing::debug!("teamhub client error: {e:#}");
                    }
                });
            }
        });
        tracing::info!("[teamhub] listening on 127.0.0.1:{}", local.port());
        Ok(())
    }

    pub async fn info(&self) -> (u16, String, String) {
        let s = self.state.lock().await;
        (
            s.port,
            s.token.clone(),
            s.bridge_path.to_string_lossy().into_owned(),
        )
    }

    /// チームを active list に追加 (renderer の setupTeamMcp 経由)
    pub async fn register_team(&self, team_id: &str, name: &str) {
        if team_id.is_empty() || team_id == "_init" {
            return;
        }
        let mut s = self.state.lock().await;
        s.active_teams.insert(team_id.to_string());
        let team = s
            .teams
            .entry(team_id.to_string())
            .or_insert_with(|| TeamInfo {
                id: team_id.to_string(),
                ..Default::default()
            });
        if !name.is_empty() {
            team.name = name.to_string();
        }
    }

    /// チームを active list から外す。戻り値が true なら active が 0 → MCP 設定削除可
    pub async fn clear_team(&self, team_id: &str) -> bool {
        let mut s = self.state.lock().await;
        s.teams.remove(team_id);
        s.active_teams.remove(team_id);
        s.active_teams.is_empty()
    }
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

async fn handle_client(
    hub: TeamHub,
    sock: tokio::net::TcpStream,
    expected_token: String,
) -> Result<()> {
    let (rd, mut wr) = sock.into_split();
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
            return Err(anyhow!("handshake line exceeds {HANDSHAKE_LINE_LIMIT} bytes"));
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
    hub.resolve_pending_recruit(&ctx.agent_id, &ctx.role).await;

    // Issue #107: BufReader::lines() は行サイズに上限が無く、`\n` 無しの巨大 line で
    // メモリ DoS になる。1 byte ずつ BufReader 経由で読み (内部 4KB buffer でまとめ取り
    // されるので syscall コストは無視できる)、RPC_LINE_LIMIT を超えたら行を破棄しつつ
    // \n まで読み捨てて接続維持する。
    use tokio::io::AsyncReadExt;
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    loop {
        buf.clear();
        let mut overflowed = false;
        loop {
            let mut byte = [0u8; 1];
            match reader.read_exact(&mut byte).await {
                Ok(_) => {}
                Err(_) => return Ok(()), // EOF / 切断
            }
            if byte[0] == b'\n' {
                break;
            }
            if !overflowed {
                if buf.len() >= RPC_LINE_LIMIT {
                    overflowed = true;
                    buf.clear();
                } else {
                    buf.push(byte[0]);
                }
            }
            // overflowed の場合は buf に push しない (= \n まで読み捨て)
        }

        if overflowed {
            tracing::warn!(
                "[teamhub] dropping RPC line: exceeded {RPC_LINE_LIMIT} bytes"
            );
            let err = serde_json::json!({
                "jsonrpc": "2.0",
                "id": null,
                "error": { "code": -32700, "message": "Parse error: line too long" }
            });
            wr.write_all(err.to_string().as_bytes()).await?;
            wr.write_all(b"\n").await?;
            continue;
        }

        // \r で終わっていたら除去
        if buf.last() == Some(&b'\r') {
            buf.pop();
        }
        if buf.is_empty() {
            continue;
        }
        let line_str = match std::str::from_utf8(&buf) {
            Ok(s) => s,
            Err(_) => {
                let err = serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": null,
                    "error": { "code": -32700, "message": "Parse error: invalid utf-8" }
                });
                wr.write_all(err.to_string().as_bytes()).await?;
                wr.write_all(b"\n").await?;
                continue;
            }
        };
        let req: serde_json::Value = match serde_json::from_str(line_str) {
            Ok(v) => v,
            Err(_) => {
                let err = serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": null,
                    "error": { "code": -32700, "message": "Parse error" }
                });
                wr.write_all(err.to_string().as_bytes()).await?;
                wr.write_all(b"\n").await?;
                continue;
            }
        };
        if let Some(resp) = protocol::handle(&hub, &ctx, &req).await {
            wr.write_all(resp.to_string().as_bytes()).await?;
            wr.write_all(b"\n").await?;
        }
    }
}

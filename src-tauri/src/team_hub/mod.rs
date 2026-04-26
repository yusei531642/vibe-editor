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
    /// agent_id → 待機中の recruit (handshake 完了で resolve)。
    /// Issue #122: team_id と role を保持して、同時 team_recruit の人数 / singleton 判定に
    /// pending を含められるようにする (旧実装は registry の handshake 済みだけを見ていたため
    /// 並行 recruit で上限超過や singleton 重複が起きえた)。
    pending_recruits: HashMap<String, PendingRecruit>,
    /// renderer から同期された role profile 一覧 (team_list_role_profiles で返す)
    role_profile_summary: Vec<RoleProfileSummary>,
    /// Leader が team_create_role / team_recruit(role_definition=...) で動的に生成した
    /// ワーカーロール。team_id ごとに分離 (チーム間の名前衝突を許容しつつ独立性を担保)。
    /// renderer 側で worker テンプレに instructions を流し込み、最終的な system prompt を組み立てる。
    /// プロセス再起動で消えるが、canvas restore 時に renderer が再投入する想定。
    dynamic_roles: HashMap<String, HashMap<String, DynamicRole>>,
}

/// Leader が team_create_role で定義した動的ワーカーロールの本体。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamicRole {
    pub id: String,
    pub label: String,
    pub description: String,
    /// 役職特有の振る舞い (worker テンプレの {dynamicInstructions} に流し込まれる)
    pub instructions: String,
    /// 任意。日本語 instructions 版。未指定なら instructions が両言語に使われる。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions_ja: Option<String>,
    /// どの team で作成されたか (ログ・スコープ確認用)
    pub team_id: String,
    /// 作成者 (ログ用)
    pub created_by_role: String,
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
    /// 動的ロールを team_create_role / team_recruit(role_definition=...) で作成できるか。
    /// Leader だけ true で、HR や動的ワーカーは false。
    #[serde(default)]
    pub can_create_role_profile: bool,
    pub default_engine: String, // "claude" | "codex"
    pub singleton: bool,
}

#[derive(Clone, Debug)]
pub struct RecruitOutcome {
    pub agent_id: String,
    pub role_profile_id: String,
}

/// pending_recruits の値。team_id と role を保持して、並行 recruit でも整合性のある
/// 人数 / singleton 判定ができるようにする (Issue #122)。
pub struct PendingRecruit {
    pub team_id: String,
    pub role_profile_id: String,
    pub tx: oneshot::Sender<RecruitOutcome>,
}

#[derive(Default, Clone)]
pub struct TeamInfo {
    pub id: String,
    pub name: String,
    pub messages: Vec<TeamMessage>,
    pub tasks: Vec<TeamTask>,
    /// 次に採番する message_id (Issue #115)。
    /// 旧実装は `messages.len() + 1` を使っていたため、履歴上限到達後はずっと同値になり ID 衝突した。
    /// 単調増加カウンタにすることで上限到達後も一意性を保つ。saturating_add で u32::MAX を超えたら
    /// 飽和するが、4 billion msgs/team は実用上発生しない。
    pub next_message_id: u32,
    /// 次に採番する task_id (Issue #116)。message_id と同じ理由で単調増加カウンタ化。
    pub next_task_id: u32,
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
                dynamic_roles: HashMap::new(),
            })),
            app_handle: Arc::new(Mutex::new(None)),
        }
    }

    /// 動的ロールを team_id スコープで登録。既存があれば上書き。
    /// 既存 builtin (`role_profile_summary` に居る id) との衝突は呼び出し側でチェック済み前提。
    pub async fn register_dynamic_role(&self, role: DynamicRole) {
        let mut s = self.state.lock().await;
        s.dynamic_roles
            .entry(role.team_id.clone())
            .or_default()
            .insert(role.id.clone(), role);
    }

    /// team_id スコープの動的ロール一覧を返す
    pub async fn get_dynamic_roles(&self, team_id: &str) -> Vec<DynamicRole> {
        let s = self.state.lock().await;
        s.dynamic_roles
            .get(team_id)
            .map(|m| m.values().cloned().collect())
            .unwrap_or_default()
    }

    /// 任意 team_id スコープから動的ロール 1 件を引く
    pub async fn get_dynamic_role(&self, team_id: &str, role_id: &str) -> Option<DynamicRole> {
        let s = self.state.lock().await;
        s.dynamic_roles
            .get(team_id)
            .and_then(|m| m.get(role_id).cloned())
    }

    /// renderer 側に dynamic_roles のスナップショットを渡せるようにする想定の hook。
    /// 現状は未使用 (未来のチーム履歴永続化で使う)
    #[allow(dead_code)]
    pub async fn export_dynamic_roles(&self, team_id: &str) -> Vec<DynamicRole> {
        self.get_dynamic_roles(team_id).await
    }

    /// canvas 復元時に renderer 側 dynamic_roles をまとめて Hub に流し込むための入口。
    /// 既存をクリアしてから一括 insert する (team_id スコープ単位)。
    #[allow(dead_code)]
    pub async fn replace_dynamic_roles(&self, team_id: &str, roles: Vec<DynamicRole>) {
        let mut s = self.state.lock().await;
        let entry = s.dynamic_roles.entry(team_id.to_string()).or_default();
        entry.clear();
        for r in roles {
            entry.insert(r.id.clone(), r);
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

    /// recruit を pending に登録する。Issue #122: 「人数 / singleton 判定」と「pending 登録」を
    /// 同じクリティカルセクションで行うことで並行 recruit による上限超過や singleton 重複を防ぐ。
    ///
    /// `current_members` は呼び出し側で先に取得した「handshake 済みメンバー (agent_id, role) の一覧」。
    /// クリティカルセクション内で pending と合わせて人数 / 役職重複をチェックし、
    /// パスしたらこの場で pending に挿入して Receiver を返す。
    pub async fn try_register_pending_recruit(
        &self,
        agent_id: String,
        team_id: String,
        role_profile_id: String,
        is_singleton: bool,
        current_members: &[(String, String)],
        max_members: usize,
    ) -> Result<oneshot::Receiver<RecruitOutcome>, String> {
        let (tx, rx) = oneshot::channel();
        let mut s = self.state.lock().await;
        // 同 team_id に属する pending を列挙
        let pending_for_team: Vec<&PendingRecruit> = s
            .pending_recruits
            .values()
            .filter(|p| p.team_id == team_id)
            .collect();
        // 人数上限チェック (handshake 済み + pending)
        let total = current_members.len() + pending_for_team.len();
        if total >= max_members {
            return Err(format!(
                "team is full ({total}/{max_members} members; including pending recruits)"
            ));
        }
        // singleton チェック (handshake 済み + pending を両方見る)
        if is_singleton {
            let already = current_members.iter().any(|(_, r)| r == &role_profile_id)
                || pending_for_team
                    .iter()
                    .any(|p| p.role_profile_id == role_profile_id);
            if already {
                return Err(format!(
                    "singleton role '{role_profile_id}' is already filled or pending in this team"
                ));
            }
        }
        s.pending_recruits.insert(
            agent_id,
            PendingRecruit {
                team_id,
                role_profile_id,
                tx,
            },
        );
        Ok(rx)
    }

    /// handshake 内で agent_id がマッチしたら呼ぶ。recruit が待機中ならここで resolve。
    pub async fn resolve_pending_recruit(&self, agent_id: &str, role_profile_id: &str) {
        let mut s = self.state.lock().await;
        if let Some(p) = s.pending_recruits.remove(agent_id) {
            let _ = p.tx.send(RecruitOutcome {
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
        // Issue #140: port は同 LAN 攻撃者が brute-force 起点に使えるため debug only で残す。
        // info にはポート無しのメッセージだけ残す。
        tracing::info!("[teamhub] listening on loopback");
        tracing::debug!("[teamhub] listening on 127.0.0.1:{}", local.port());
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
        // 動的ロールもチーム単位でクリア (チーム破棄でロール定義を残す意味は無い)
        s.dynamic_roles.remove(team_id);
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

    // Issue #107 + #133: BufReader::lines() は行サイズに上限が無く DoS になる。
    // 旧実装は 1 byte ずつ read_exact を呼んでいたため、長文 message 1 行 (10 KB) で
    // 10000 回の future poll が走り tokio worker を飽和させていた。
    // → AsyncBufReadExt::read_until(b'\n', ...) でまとめ取りし、戻り値が
    //   RPC_LINE_LIMIT を超えていたらその場で破棄する方針に変更。
    //   read_until は内部 BufReader バッファごと一気にコピーするので poll 回数が激減する。
    use tokio::io::{AsyncBufReadExt, AsyncReadExt};
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    loop {
        buf.clear();
        // RPC_LINE_LIMIT + 1 までは積極的に取り、超えたら overflowed として破棄する。
        // 1 行が極端に長くてもメモリ使用量は LIMIT で頭打ちになる。
        let mut overflowed = false;
        // tokio の BufReader::read_until は max 制限が無いので、自前で take してから読む。
        // ただし client が \n を送ってこないと無限読みになるため、LIMIT+1 で take。
        let mut limited = (&mut reader).take((RPC_LINE_LIMIT as u64) + 1);
        match limited.read_until(b'\n', &mut buf).await {
            Ok(0) => return Ok(()), // EOF / 切断
            Ok(_) => {}
            Err(_) => return Ok(()),
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

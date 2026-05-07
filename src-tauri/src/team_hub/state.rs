#[cfg(unix)]
use super::bind_local_listener;
use super::error::{AckError, AckFailPhase};
use super::{bridge, handle_client, hex_encode, TeamHub, MAX_CONCURRENT_CLIENTS};
#[cfg(windows)]
use super::{create_pipe_server, new_pipe_endpoint};
use crate::commands::team_history::HandoffReference;
use crate::commands::team_state::{
    HandoffLifecycleEvent, HumanGateState, TeamOrchestrationState, TeamTaskSnapshot,
    WorkerReportSnapshot, TEAM_STATE_SCHEMA_VERSION,
};
use crate::pty::SessionRegistry;
use anyhow::Result;
use once_cell::sync::OnceCell;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::{oneshot, Mutex, Semaphore};
pub(crate) struct HubState {
    /// チーム別の会話履歴・タスク
    pub(crate) teams: HashMap<String, TeamInfo>,
    /// アクティブな team_id (MCP 設定の参照カウント)
    pub(crate) active_teams: HashSet<String>,
    /// bridge.js が net.createConnection() に渡す接続先文字列。
    /// Unix は socket path、Windows は named pipe path。
    pub(crate) endpoint: String,
    /// ハンドシェイクトークン (16 進 48 文字)
    pub(crate) token: String,
    /// 書き出し済みの bridge スクリプトパス
    pub(crate) bridge_path: PathBuf,
    /// agent_id → 待機中の recruit (handshake 完了で resolve)。
    /// Issue #122: team_id と role を保持して、同時 team_recruit の人数 / singleton 判定に
    /// pending を含められるようにする (旧実装は registry の handshake 済みだけを見ていたため
    /// 並行 recruit で上限超過や singleton 重複が起きえた)。
    pub(crate) pending_recruits: HashMap<String, PendingRecruit>,
    /// Issue #183: agent_id を初回 handshake で確定した role に bind する。
    /// 別プロセスが同 agent_id で接続してきても異なる role を主張できなくする。
    pub(crate) agent_role_bindings: HashMap<String, String>,
    /// renderer から同期された role profile 一覧 (team_list_role_profiles で返す)
    pub(crate) role_profile_summary: Vec<RoleProfileSummary>,
    /// Leader が team_create_role / team_recruit(role_definition=...) で動的に生成した
    /// ワーカーロール。team_id ごとに分離 (チーム間の名前衝突を許容しつつ独立性を担保)。
    /// renderer 側で worker テンプレに instructions を流し込み、最終的な system prompt を組み立てる。
    /// プロセス再起動で消えるが、canvas restore 時に renderer が再投入する想定。
    pub(crate) dynamic_roles: HashMap<String, HashMap<String, DynamicRole>>,
    /// Issue #342 Phase 3 (3.2): agent_id 単位の診断 timestamp / counter。
    /// `team_diagnostics` MCP ツールが leader/hr の権限ガード越しに返す。
    /// in-memory only (プロセス再起動でリセット、計画の受け入れ基準で明記済み)。
    pub(crate) member_diagnostics: HashMap<String, MemberDiagnostics>,
    /// Issue #526: vibe-team の advisory file lock 表 (team_id × normalized_path → FileLock)。
    /// `team_lock_files` で取得、`team_unlock_files` で解放、`team_assign_task` の
    /// `target_paths` 引数で peek (競合検知)。in-memory only (Hub 再起動で全 clear)、
    /// TTL は設けない (本 issue では out-of-scope)。`team_dismiss` 時には対象 agent_id の
    /// 全 lock を `release_all_for_agent` で一括解放する想定。
    pub(crate) file_locks: HashMap<(String, String), crate::team_hub::file_locks::FileLock>,
}

/// Issue #342 Phase 3 (3.1): `team_diagnostics` で返す診断 timestamp / counter。
/// 全 timestamp は `chrono::Utc::now().to_rfc3339()` (ISO8601 / RFC3339)。
/// counter は `saturating_add(1)` でオーバーフロー時は `u64::MAX` 飽和。
#[derive(Clone, Debug, Default)]
pub struct MemberDiagnostics {
    /// `try_register_pending_recruit` が成功した瞬間の timestamp。
    /// 旧 entry (handshake 未完で再 recruit された agent_id) は新値で上書き。
    pub recruited_at: String,
    /// `resolve_pending_recruit` で handshake が完了した最後の timestamp。
    /// `online: true` だが `last_handshake_at: null` → handshake 未完を可視化。
    pub last_handshake_at: Option<String>,
    /// Agent 自身が操作したアクティビティ (handshake / send / read / status / update_task / dismiss) の最終時刻。
    /// 他者からの team_send 配信成功では更新しない。
    pub last_seen_at: Option<String>,
    /// この agent が他者から message を受領した最終時刻 (inject 成功 = 受領)。
    pub last_message_in_at: Option<String>,
    /// この agent が team_send で発信した最終時刻。
    pub last_message_out_at: Option<String>,
    pub messages_in_count: u64,
    pub messages_out_count: u64,
    pub tasks_claimed_count: u64,
    /// Issue #409: `team_status(status)` で agent が自己申告した最新ステータス文字列。
    /// Leader が `team_diagnostics` で「直近で生きているか / 何をしているか」を判断するために使う。
    pub current_status: Option<String>,
    /// Issue #409: `current_status` を更新した最終時刻 (RFC3339)。
    pub last_status_at: Option<String>,
    /// Issue #524: PTY から最後に出力 byte が流れた時刻 (RFC3339)。
    /// agent process が「ハングしているか / 単に待機中か」を Leader が判定する物理シグナルとして使う。
    /// `team_status` の自己申告と乖離した場合 (例: status は "running tests" だが PTY 出力が 5 分間無い)
    /// に diagnostics 側で `autoStale: true` を立てる元データ。
    /// 大量出力で hub の lock 競合を避けるため、PTY batcher が 1 秒間隔で dedup して update する。
    pub last_pty_output_at: Option<String>,
}

/// Issue #342 Phase 3 (3.11): tracing-appender が書き出すログファイルの絶対パスを
/// プロセス起動時に 1 度だけ記録するグローバル。`team_diagnostics` MCP ツールで
/// `serverLogPath` として返す際に参照する。
///
/// init_logging() 内で `set_server_log_path()` を呼ぶ。env var `VIBE_TEAM_LOG_PATH`
/// が指定されていれば `server_log_path_for_diagnostics()` 側でそちらを優先する。
/// ファイルロガー無効 (stderr-only モード) の場合は `None` のままで、診断 API 側が
/// `"<stderr>"` を返す。
static SERVER_LOG_PATH: OnceCell<PathBuf> = OnceCell::new();

/// init_logging() から起動時に 1 度だけ呼ぶ。2 回目以降は無視される。
pub fn set_server_log_path(p: PathBuf) {
    let _ = SERVER_LOG_PATH.set(p);
}

/// home directory プレフィックスを `~` に reduce する。
/// home が解決できない / s が home 配下でないときは原文を返す。
fn reduce_home_prefix(s: &str) -> String {
    let Some(home) = dirs::home_dir() else {
        return s.to_string();
    };
    let home_s = home.to_string_lossy().to_string();
    // Windows では `\` と `/` の混在があり得るので両形で試す
    if let Some(rest) = s.strip_prefix(&home_s) {
        return format!("~{rest}");
    }
    let home_alt = home_s.replace('\\', "/");
    let s_alt = s.replace('\\', "/");
    if let Some(rest) = s_alt.strip_prefix(&home_alt) {
        return format!("~{rest}");
    }
    s.to_string()
}

/// `team_diagnostics` の `serverLogPath` 用に整形済み文字列を返す。
///   - env var `VIBE_TEAM_LOG_PATH` が空でなければそれを優先 (絶対パス想定、空白 trim)
///   - そうでなければ起動時に記録したファイルパス
///   - どちらも無ければ `"<stderr>"` (= stderr-only モード)
///
/// 戻り値は home prefix を `~` に reduce 済み (Reviewer D Major 反映)。
pub fn server_log_path_for_diagnostics() -> String {
    if let Ok(v) = std::env::var("VIBE_TEAM_LOG_PATH") {
        let trimmed = v.trim();
        if !trimmed.is_empty() {
            return reduce_home_prefix(trimmed);
        }
    }
    match SERVER_LOG_PATH.get() {
        Some(p) => reduce_home_prefix(&p.to_string_lossy()),
        None => "<stderr>".to_string(),
    }
}

#[cfg(test)]
mod path_tests {
    use super::reduce_home_prefix;

    /// home prefix が正しく `~` に置換され、home 配下でないパスは原文のまま。
    /// home 解決失敗環境を想定した静的テストではないので、CI 環境次第で home が
    /// 存在しないと一部スキップされる点だけ承知 (Linux CI / Windows CI とも home はある)。
    #[test]
    fn reduces_home_prefix_when_under_home() {
        let Some(home) = dirs::home_dir() else {
            return; // home 取れない環境ではスキップ (CI 上は通常存在する)
        };
        let inside = crate::util::config_paths::vibe_root()
            .join("logs")
            .join("vibe-editor.log");
        let inside_str = inside.to_string_lossy().to_string();
        let reduced = reduce_home_prefix(&inside_str);
        // `~/.vibe-editor/logs/vibe-editor.log` 形 (区切り文字は OS 依存だが prefix は `~`)
        assert!(
            reduced.starts_with('~'),
            "expected '~' prefix, got: {reduced}"
        );
        assert!(reduced.contains(".vibe-editor"));
    }

    #[test]
    fn keeps_path_as_is_when_outside_home() {
        // home 配下でないパスは reduce されない。
        // どの OS でも `/tmp/elsewhere.log` は home 配下にならない (Windows でも C:\Users\ 起点なので無関係)。
        let outside = if cfg!(windows) {
            r"D:\nowhere\elsewhere.log"
        } else {
            "/tmp/elsewhere.log"
        };
        let reduced = reduce_home_prefix(outside);
        assert_eq!(reduced, outside);
    }
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
///
/// Issue #342 Phase 1: ack 駆動への移行に伴い、以下を追加:
/// - `requester_agent_id`: ack 認可ガード時の診断ログ用 (誰の recruit が落ちたか追跡可能にする)
/// - `ack_tx`: renderer の `app_recruit_ack` invoke を待つための oneshot。受領通知のみで
///   handshake 完了は別経路 (`tx`) で待つ。
/// - `ack_done`: 重複 ack を弾くための AtomicBool。renderer のバグや競合で 2 回 ack が来ても
///   2 回目以降は no-op になる。
pub struct PendingRecruit {
    pub team_id: String,
    pub role_profile_id: String,
    pub requester_agent_id: String,
    pub tx: oneshot::Sender<RecruitOutcome>,
    pub ack_tx: Option<oneshot::Sender<RecruitAckOutcome>>,
    pub ack_done: AtomicBool,
}

/// Issue #342 Phase 1: renderer から `app_recruit_ack` で渡される受領通知 outcome。
///
/// `ok=true` は「renderer が `team:recruit-request` を受け取って addCard / spawn を開始した」
/// という受領通知のみ。**handshake 完了ではない**。真の成功判定は既存の
/// `resolve_pending_recruit` (handshake 経由) で行う。
///
/// `ok=false` の場合は `phase` に失敗種別 (spawn / engine_binary_missing / 等) が入り、
/// `reason` に追加情報 (任意の文字列、長さ 256 byte 上限) が入る。
#[derive(Clone, Debug)]
pub struct RecruitAckOutcome {
    pub ok: bool,
    pub reason: Option<String>,
    pub phase: Option<AckFailPhase>,
}

/// Issue #342 Phase 1: `try_register_pending_recruit` が返す 2 系統の Receiver。
///
/// - `ack`: renderer から `app_recruit_ack` invoke が来たら resolve される短期 (5s) 待機用
/// - `handshake`: spawn された agent が socket / pipe で handshake を済ませると resolve される
///   長期 (30s) 待機用 (既存 `resolve_pending_recruit` 経路)
pub struct PendingRecruitChannels {
    pub handshake: oneshot::Receiver<RecruitOutcome>,
    pub ack: oneshot::Receiver<RecruitAckOutcome>,
}

#[derive(Default, Clone)]
pub struct TeamInfo {
    pub name: String,
    /// Issue #470: durable orchestration state の保存先解決用。
    pub project_root: Option<String>,
    pub messages: VecDeque<TeamMessage>,
    pub tasks: VecDeque<TeamTask>,
    pub worker_reports: VecDeque<WorkerReportSnapshot>,
    pub latest_handoff: Option<HandoffReference>,
    pub handoff_events: VecDeque<HandoffLifecycleEvent>,
    pub human_gate: HumanGateState,
    pub next_actions: VecDeque<String>,
    /// Issue #359: leader handoff 中の role 宛て二重配送を避けるため、
    /// team_send("leader", ...) はこの agent_id が設定されていれば単一宛先に絞る。
    pub active_leader_agent_id: Option<String>,
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
    /// Issue #342 Phase 2: 送信時点で `resolve_targets` が解決した宛先 agent_id 群。
    /// `team_read` の `is_for_me` 判定はこれを SSOT として使う (raw `to` を read 時に
    /// `ctx.role` / `ctx.agent_id` で再解釈する旧設計は identity 分離 (HMR / 再接続 /
    /// team_id 不一致) に対してサイレント沈黙する脆弱性があったため)。
    /// in-memory only。`#[derive(Clone)]` のみで Serialize/Deserialize は付けない
    /// (TeamMessage 自体が永続化対象ではないため migration 不要)。
    pub resolved_recipient_ids: Vec<String>,
    pub message: String,
    pub timestamp: String,
    pub read_by: Vec<String>,
    /// Issue #342 Phase 3 (3.7 / 3.8): 各 agent_id が `read_by` に追加された ISO8601 時刻。
    /// `team_read` 戻り値の `receivedAt` で参照される。
    /// Issue #378 以降、`team_send` の `receivedAtPerRecipient` / `deliveredAtPerRecipient` は
    /// `delivered_at` を正本とするため、ここから直接参照されることはなくなった。
    /// in-memory only (TeamMessage 自体が永続化対象でないため)。
    pub read_at: HashMap<String, String>,
    /// Issue #378: 「PTY への inject (= 配達) が成功した」事実を `read_by` (= 受信側
    /// agent が認識して `team_read` を呼んだ) と分離して保持する。
    /// 旧実装は inject 成功で sender に加えて recipient まで `read_by` に追加していたため、
    /// worker が実際には Enter を確認していない 1 回目の指示を「既読」として扱い、
    /// `team_read({unread_only: true})` でも 0 件しか返さなかった (= 再送指示までユーザーが
    /// 異変に気付けない)。delivered_to / delivered_at を別 channel として持ち、`read_by` は
    /// sender 自己印 + `team_read` 実行のときだけ更新する。
    /// in-memory only (永続化対象ではないため migration 不要)。
    pub delivered_to: Vec<String>,
    pub delivered_at: HashMap<String, String>,
}

#[derive(Clone)]
pub struct TeamTask {
    pub id: u32,
    pub assigned_to: String,
    pub description: String,
    pub status: String,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: Option<String>,
    pub summary: Option<String>,
    pub blocked_reason: Option<String>,
    pub next_action: Option<String>,
    pub artifact_path: Option<String>,
    pub blocked_by_human_gate: bool,
    pub required_human_decision: Option<String>,
}

impl TeamTask {
    pub fn to_snapshot(&self) -> TeamTaskSnapshot {
        TeamTaskSnapshot {
            id: self.id,
            assigned_to: self.assigned_to.clone(),
            description: self.description.clone(),
            status: self.status.clone(),
            created_by: self.created_by.clone(),
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
            summary: self.summary.clone(),
            blocked_reason: self.blocked_reason.clone(),
            next_action: self.next_action.clone(),
            artifact_path: self.artifact_path.clone(),
            blocked_by_human_gate: self.blocked_by_human_gate,
            required_human_decision: self.required_human_decision.clone(),
        }
    }

    pub fn from_snapshot(snapshot: TeamTaskSnapshot) -> Self {
        Self {
            id: snapshot.id,
            assigned_to: snapshot.assigned_to,
            description: snapshot.description,
            status: snapshot.status,
            created_by: snapshot.created_by,
            created_at: snapshot.created_at,
            updated_at: snapshot.updated_at,
            summary: snapshot.summary,
            blocked_reason: snapshot.blocked_reason,
            next_action: snapshot.next_action,
            artifact_path: snapshot.artifact_path,
            blocked_by_human_gate: snapshot.blocked_by_human_gate,
            required_human_decision: snapshot.required_human_decision,
        }
    }
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
                endpoint: String::new(),
                token: String::new(),
                bridge_path: PathBuf::new(),
                pending_recruits: HashMap::new(),
                agent_role_bindings: HashMap::new(),
                role_profile_summary: Vec::new(),
                dynamic_roles: HashMap::new(),
                member_diagnostics: HashMap::new(),
                file_locks: HashMap::new(),
            })),
            app_handle: Arc::new(Mutex::new(None)),
        }
    }

    // ===== Issue #526: file lock helpers (TeamHub method 経由で HubState の file_locks を操作) =====

    /// `paths` を team_id × agent_id でロック取得試行する。partial success (一部 conflict でも残りは locked)。
    pub async fn try_acquire_file_locks(
        &self,
        team_id: &str,
        agent_id: &str,
        role: &str,
        paths: &[String],
    ) -> crate::team_hub::file_locks::LockResult {
        let mut s = self.state.lock().await;
        crate::team_hub::file_locks::try_acquire(&mut s.file_locks, team_id, agent_id, role, paths)
    }

    /// `paths` のうち自分が保持するロックを解放する。
    pub async fn release_file_locks(
        &self,
        team_id: &str,
        agent_id: &str,
        paths: &[String],
    ) -> crate::team_hub::file_locks::UnlockResult {
        let mut s = self.state.lock().await;
        crate::team_hub::file_locks::release(&mut s.file_locks, team_id, agent_id, paths)
    }

    /// 指定 agent が team 内で保持する全 lock を解放する。`team_dismiss` 時に呼ぶ想定。
    pub async fn release_all_file_locks_for_agent(
        &self,
        team_id: &str,
        agent_id: &str,
    ) -> u32 {
        let mut s = self.state.lock().await;
        crate::team_hub::file_locks::release_all_for_agent(&mut s.file_locks, team_id, agent_id)
    }

    /// `paths` の現在の lock 保持者一覧 (assign_task の競合検知用、agent_id_filter で自分宛除外可)。
    pub async fn peek_file_locks(
        &self,
        team_id: &str,
        agent_id_filter: Option<&str>,
        paths: &[String],
    ) -> Vec<crate::team_hub::file_locks::LockConflict> {
        let s = self.state.lock().await;
        crate::team_hub::file_locks::peek(&s.file_locks, team_id, agent_id_filter, paths)
    }

    /// team 内の全 lock 一覧 (将来の team_diagnostics 拡張 / UI 表示用)。
    /// 現在は MCP API 経由の caller が居ないので `#[allow(dead_code)]`。
    #[allow(dead_code)]
    pub async fn list_file_locks_for_team(
        &self,
        team_id: &str,
    ) -> Vec<crate::team_hub::file_locks::FileLock> {
        let s = self.state.lock().await;
        crate::team_hub::file_locks::list_for_team(&s.file_locks, team_id)
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

    /// recruit を pending に登録する。Issue #122: 「singleton 判定」と「pending 登録」を
    /// 同じクリティカルセクションで行うことで並行 recruit による singleton 重複を防ぐ。
    ///
    /// Issue #386: 1 チームあたりのメンバー人数上限は撤廃済み。
    ///
    /// `current_members` は呼び出し側で先に取得した「handshake 済みメンバー (agent_id, role) の一覧」。
    /// クリティカルセクション内で pending と合わせて役職重複をチェックし、
    /// パスしたらこの場で pending に挿入して Receiver を返す。
    pub async fn try_register_pending_recruit(
        &self,
        agent_id: String,
        team_id: String,
        role_profile_id: String,
        requester_agent_id: String,
        is_singleton: bool,
        current_members: &[(String, String)],
    ) -> Result<PendingRecruitChannels, String> {
        let (tx, rx) = oneshot::channel();
        let (ack_tx, ack_rx) = oneshot::channel();
        let mut s = self.state.lock().await;
        // 同 team_id に属する pending を列挙
        let pending_for_team: Vec<&PendingRecruit> = s
            .pending_recruits
            .values()
            .filter(|p| p.team_id == team_id)
            .collect();
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
        // Issue #342 Phase 3 (3.3): recruit 時の診断 entry を初期化。
        // recruited_at は新規上書き (再 recruit を可視化)、他 timestamp/counter は default で初期化。
        let now_iso = chrono::Utc::now().to_rfc3339();
        s.member_diagnostics.insert(
            agent_id.clone(),
            MemberDiagnostics {
                recruited_at: now_iso,
                ..MemberDiagnostics::default()
            },
        );
        s.pending_recruits.insert(
            agent_id,
            PendingRecruit {
                team_id,
                role_profile_id,
                requester_agent_id,
                tx,
                ack_tx: Some(ack_tx),
                ack_done: AtomicBool::new(false),
            },
        );
        Ok(PendingRecruitChannels {
            handshake: rx,
            ack: ack_rx,
        })
    }

    /// handshake 内で agent_id がマッチしたら呼ぶ。recruit が待機中ならここで resolve。
    /// Issue #183: client が送ってきた role が
    ///   1. pending recruit の予約 role と一致するか (新規 recruit 経路)
    ///   2. 既存 agent_role_bindings に bind 済み role と一致するか (再接続経路)
    ///
    /// を照合する。どちらも不一致なら false を返してハンドラ側で接続切断。
    /// 初回 handshake が成功したら agent_id → role を bind する。
    ///
    /// Issue #342 Phase 2: `team_id` も照合対象に追加。pending の `team_id` と
    /// handshake で送られてきた `team_id` が一致しない場合は false を返して接続を切る
    /// (cross-team 偽 handshake / 旧 context 残骸の混線を防ぐ)。`agent_role_bindings`
    /// の構造拡張は行わない (registry が `(agent_id, team_id)` の SSOT のため)。
    pub async fn resolve_pending_recruit(
        &self,
        agent_id: &str,
        team_id: &str,
        role_profile_id: &str,
    ) -> bool {
        let mut s = self.state.lock().await;
        if let Some(p) = s.pending_recruits.get(agent_id) {
            if p.team_id != team_id {
                tracing::warn!(
                    "[teamhub] team_id mismatch on handshake (pending) agent={} expected={} got={}",
                    agent_id,
                    p.team_id,
                    team_id
                );
                return false;
            }
            if p.role_profile_id != role_profile_id {
                tracing::warn!(
                    "[teamhub] role mismatch on handshake (pending) agent={} expected={} got={}",
                    agent_id,
                    p.role_profile_id,
                    role_profile_id
                );
                return false;
            }
            let p = s.pending_recruits.remove(agent_id).expect("just checked");
            let _ = p.tx.send(RecruitOutcome {
                agent_id: agent_id.to_string(),
                role_profile_id: role_profile_id.to_string(),
            });
        }
        // 既に bind 済みの agent_id なら role 一致を強制
        if let Some(bound) = s.agent_role_bindings.get(agent_id) {
            if bound != role_profile_id {
                tracing::warn!(
                    "[teamhub] role mismatch on handshake (rebind) agent={} bound={} got={}",
                    agent_id,
                    bound,
                    role_profile_id
                );
                return false;
            }
        } else {
            // 初回 handshake で bind
            s.agent_role_bindings
                .insert(agent_id.to_string(), role_profile_id.to_string());
        }
        // Issue #342 Phase 3 (3.3): 初回 handshake / 再接続 handshake いずれも last_handshake_at と
        // last_seen_at を更新する。recruit 経路を通らずに直接 handshake してきた場合 (= 旧 context
        // 残骸の再接続等) は entry が無いので or_default で生成する。
        let now_iso = chrono::Utc::now().to_rfc3339();
        let entry = s
            .member_diagnostics
            .entry(agent_id.to_string())
            .or_default();
        if entry.recruited_at.is_empty() {
            entry.recruited_at = now_iso.clone();
        }
        entry.last_handshake_at = Some(now_iso.clone());
        entry.last_seen_at = Some(now_iso);
        true
    }

    /// timeout 等でキャンセル: pending を破棄 (送信側 dropped で recv が Err になる)
    pub async fn cancel_pending_recruit(&self, agent_id: &str) {
        let mut s = self.state.lock().await;
        s.pending_recruits.remove(agent_id);
    }

    /// Issue #342 Phase 3 (3.3): `team_diagnostics` で見える member_diagnostics エントリを返す。
    /// agent_id が未登録なら None。
    pub async fn get_member_diagnostics(&self, agent_id: &str) -> Option<MemberDiagnostics> {
        self.state
            .lock()
            .await
            .member_diagnostics
            .get(agent_id)
            .cloned()
    }

    /// Issue #342 Phase 3 (3.3): MemberDiagnostics 全体のスナップショットを返す。
    /// `team_diagnostics` MCP ツールは protocol.rs 側で state.lock を直接取るため、
    /// この helper は外部 (テスト / 将来の機能拡張) からの read-only スナップショット用。
    #[allow(dead_code)]
    pub async fn snapshot_member_diagnostics(&self) -> HashMap<String, MemberDiagnostics> {
        self.state.lock().await.member_diagnostics.clone()
    }

    /// Issue #342 Phase 1: renderer 側 `app_recruit_ack` invoke の核ロジック。
    ///
    /// 認可ガード (3 重防御):
    ///   1. **pending エントリ存在確認**: `pending_recruits.get(agent_id)` が None なら no-op + warn
    ///   2. **team_id 一致確認**: pending の `team_id != expected_team_id` なら no-op + warn
    ///      (cross-team から偽の cancel を仕込めないようにする)
    ///   3. **重複 ack 弾き**: `ack_done.compare_exchange(false, true, ...)` で 2 回目以降を no-op 化
    ///
    /// `ok=true` を受け取っても **MCP `team_recruit` の戻り値はまだ成功にしない**。
    /// 真の成功判定は `resolve_pending_recruit` (handshake 経由) のみ。renderer 信頼境界違反で
    /// 偽 `ok=true` を打たれても MCP caller は騙されない。
    pub async fn resolve_recruit_ack(
        &self,
        agent_id: &str,
        expected_team_id: &str,
        outcome: RecruitAckOutcome,
    ) -> Result<(), AckError> {
        let mut s = self.state.lock().await;
        let Some(pending) = s.pending_recruits.get_mut(agent_id) else {
            tracing::warn!(
                "[teamhub] recruit_ack ignored: no pending recruit for agent={agent_id}"
            );
            return Err(AckError::NotFound);
        };
        if pending.team_id != expected_team_id {
            tracing::warn!(
                "[teamhub] recruit_ack ignored: team_id mismatch agent={agent_id} \
                 pending_team={} expected_team={expected_team_id} requester={}",
                pending.team_id,
                pending.requester_agent_id
            );
            return Err(AckError::TeamMismatch);
        }
        if pending
            .ack_done
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            tracing::warn!("[teamhub] recruit_ack ignored: already acked agent={agent_id}");
            return Err(AckError::AlreadyAcked);
        }
        let ack_tx = pending.ack_tx.take();
        // pending エントリ自体は handshake 待機中の `tx` をまだ保持している必要があるため remove しない。
        drop(s);
        if let Some(tx) = ack_tx {
            // 受信側 (team_recruit) が既に drop していても無視 (タイムアウト後の遅延 ack 等)
            let _ = tx.send(outcome);
        }
        Ok(())
    }

    /// setup 後に AppHandle を注入 (event::emit で使う)
    pub async fn set_app_handle(&self, app: tauri::AppHandle) {
        let mut g = self.app_handle.lock().await;
        *g = Some(app);
    }

    pub async fn start(&self) -> Result<()> {
        let mut state = self.state.lock().await;
        if !state.endpoint.is_empty() {
            return Ok(());
        }
        // ハンドシェイクトークンを生成 (24 byte → hex 48 文字)
        use rand::RngCore;
        let mut buf = [0u8; 24];
        rand::thread_rng().fill_bytes(&mut buf);
        state.token = hex_encode(&buf);

        // bridge スクリプトを `~/.vibe-editor/team-bridge.js` に書き出し
        // Issue #143 (Security):
        //   - symlink replacement attack 対策: 既存ファイルが symlink ならエラー扱いで除去
        //   - 書き込み中クラッシュ耐性 + 他ユーザ可読性回避のため atomic_write を使う
        let dir = crate::util::config_paths::vibe_root();
        tokio::fs::create_dir_all(&dir).await?;
        let bridge_path = dir.join("team-bridge.js");
        // 既存 path が symlink / regular file 以外なら削除して再生成する
        if let Ok(meta) = tokio::fs::symlink_metadata(&bridge_path).await {
            let ft = meta.file_type();
            if ft.is_symlink() || (!ft.is_file()) {
                tracing::warn!(
                    "[teamhub] removing pre-existing non-regular bridge path (symlink={}, dir={})",
                    ft.is_symlink(),
                    ft.is_dir()
                );
                let _ = tokio::fs::remove_file(&bridge_path).await;
            }
        }
        crate::commands::atomic_write::atomic_write(&bridge_path, bridge::SOURCE.as_bytes())
            .await
            .map_err(|e| anyhow::anyhow!("atomic_write bridge.js failed: {e:#}"))?;
        // Unix: 自分自身しか読めないように 0o600 を強制 (best-effort)
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let perm = std::fs::Permissions::from_mode(0o600);
            let _ = tokio::fs::set_permissions(&bridge_path, perm).await;
        }
        state.bridge_path = bridge_path;
        let token = state.token.clone();

        #[cfg(unix)]
        {
            let (listener, endpoint) = bind_local_listener().await?;
            state.endpoint = endpoint.clone();
            drop(state);

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
                        let _permit = permit;
                        if let Err(e) = handle_client(hub2, sock, token).await {
                            tracing::debug!("teamhub client error: {e:#}");
                        }
                    });
                }
            });
            tracing::info!("[teamhub] listening on local unix socket");
            tracing::debug!("[teamhub] endpoint={endpoint}");
            return Ok(());
        }

        #[cfg(windows)]
        {
            let endpoint = new_pipe_endpoint();
            let mut listener = create_pipe_server(&endpoint, true)?;
            state.endpoint = endpoint.clone();
            drop(state);

            let sem = Arc::new(Semaphore::new(MAX_CONCURRENT_CLIENTS));
            let hub = self.clone();
            let endpoint_for_loop = endpoint.clone();
            tokio::spawn(async move {
                loop {
                    if let Err(e) = listener.connect().await {
                        tracing::warn!("teamhub pipe connect failed: {e}");
                        break;
                    }
                    let connected = listener;
                    listener = match create_pipe_server(&endpoint_for_loop, false) {
                        Ok(next) => next,
                        Err(e) => {
                            tracing::error!("teamhub pipe rebind failed: {e:#}");
                            break;
                        }
                    };
                    let Ok(permit) = sem.clone().try_acquire_owned() else {
                        tracing::warn!(
                            "[teamhub] rejecting connection: client limit ({}) reached",
                            MAX_CONCURRENT_CLIENTS
                        );
                        drop(connected);
                        continue;
                    };
                    let hub2 = hub.clone();
                    let token = token.clone();
                    tokio::spawn(async move {
                        let _permit = permit;
                        if let Err(e) = handle_client(hub2, connected, token).await {
                            tracing::debug!("teamhub client error: {e:#}");
                        }
                    });
                }
            });
            tracing::info!("[teamhub] listening on local named pipe");
            tracing::debug!("[teamhub] endpoint={endpoint}");
            Ok(())
        }
    }

    pub async fn info(&self) -> (String, String, String) {
        let s = self.state.lock().await;
        (
            s.endpoint.clone(),
            s.token.clone(),
            s.bridge_path.to_string_lossy().into_owned(),
        )
    }

    /// チームを active list に追加 (renderer の setupTeamMcp 経由)
    pub async fn register_team(&self, team_id: &str, name: &str, project_root: Option<&str>) {
        if team_id.is_empty() || team_id == "_init" {
            return;
        }
        let persisted = match project_root.map(str::trim).filter(|v| !v.is_empty()) {
            Some(root) => {
                crate::commands::team_state::load_orchestration_state(root, team_id).await
            }
            None => None,
        };
        let mut s = self.state.lock().await;
        s.active_teams.insert(team_id.to_string());
        let team = s
            .teams
            .entry(team_id.to_string())
            .or_insert_with(TeamInfo::default);
        if let Some(root) = project_root.map(str::trim).filter(|v| !v.is_empty()) {
            team.project_root = Some(root.to_string());
        }
        if !name.is_empty() {
            team.name = name.to_string();
        }
        if let Some(persisted) = persisted {
            if team.active_leader_agent_id.is_none() {
                team.active_leader_agent_id = persisted.active_leader_agent_id;
            }
            if team.latest_handoff.is_none() {
                team.latest_handoff = persisted.latest_handoff;
            }
            if team.tasks.is_empty() {
                team.tasks = persisted
                    .tasks
                    .into_iter()
                    .map(TeamTask::from_snapshot)
                    .collect();
                team.next_task_id = team.tasks.iter().map(|task| task.id).max().unwrap_or(0);
            }
            if team.worker_reports.is_empty() {
                team.worker_reports = persisted.worker_reports.into_iter().collect();
            }
            if team.handoff_events.is_empty() {
                team.handoff_events = persisted.handoff_events.into_iter().collect();
            }
            if !persisted.next_actions.is_empty() && team.next_actions.is_empty() {
                team.next_actions = persisted.next_actions.into_iter().collect();
            }
            if persisted.human_gate.blocked {
                team.human_gate = persisted.human_gate;
            }
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

    /// Issue #359: app 側の leader replacement 経路から active leader を切り替える。
    /// 通常の team_recruit singleton 制約を迂回して同一 teamId に新 leader を直接 spawn するため、
    /// role 宛て配送だけは Hub 側で単一 leader に固定する。
    pub async fn set_active_leader(&self, team_id: &str, agent_id: Option<String>) {
        if team_id.trim().is_empty() {
            return;
        }
        {
            let mut s = self.state.lock().await;
            let team = s
                .teams
                .entry(team_id.to_string())
                .or_insert_with(TeamInfo::default);
            team.active_leader_agent_id = agent_id.filter(|v| !v.trim().is_empty());
        }
        if let Err(e) = self.persist_team_state(team_id).await {
            tracing::warn!("[teamhub] persist active leader failed: {e}");
        }
    }

    /// Issue #470: TeamHub の in-memory orchestration state を team-state に保存する。
    pub async fn persist_team_state(&self, team_id: &str) -> Result<(), String> {
        let snapshot = {
            let s = self.state.lock().await;
            let Some(team) = s.teams.get(team_id) else {
                return Ok(());
            };
            let Some(project_root) = team.project_root.clone() else {
                return Ok(());
            };
            if project_root.trim().is_empty() {
                return Ok(());
            }
            TeamOrchestrationState {
                schema_version: TEAM_STATE_SCHEMA_VERSION,
                project_root,
                team_id: team_id.to_string(),
                active_leader_agent_id: team.active_leader_agent_id.clone(),
                latest_handoff: team.latest_handoff.clone(),
                tasks: team.tasks.iter().map(TeamTask::to_snapshot).collect(),
                pending_tasks: Vec::new(),
                worker_reports: team.worker_reports.iter().cloned().collect(),
                human_gate: team.human_gate.clone(),
                next_actions: team.next_actions.iter().cloned().collect(),
                handoff_events: team.handoff_events.iter().cloned().collect(),
                updated_at: chrono::Utc::now().to_rfc3339(),
            }
        };
        Ok(
            crate::commands::team_state::save_orchestration_state(snapshot)
                .await
                .map(|_| ())?,
        )
    }

    /// Issue #470: handoff lifecycle を handoff store と team-state の両方へ記録する。
    pub async fn record_handoff_lifecycle(
        &self,
        team_id: &str,
        handoff_id: &str,
        status: &str,
        agent_id: Option<String>,
        note: Option<String>,
    ) -> Result<(), String> {
        let project_root = {
            let s = self.state.lock().await;
            s.teams
                .get(team_id)
                .and_then(|team| team.project_root.clone())
                .ok_or_else(|| "project_root is not registered for this team".to_string())?
        };
        let handoff = crate::commands::handoffs::update_handoff_status_file(
            &project_root,
            Some(team_id),
            handoff_id,
            status,
            agent_id.clone(),
        )
        .await?;
        let reference = crate::commands::handoffs::handoff_reference_of(&handoff);
        {
            let mut s = self.state.lock().await;
            let team = s
                .teams
                .entry(team_id.to_string())
                .or_insert_with(TeamInfo::default);
            team.project_root.get_or_insert(project_root);
            team.latest_handoff = Some(reference);
            team.handoff_events.push_back(HandoffLifecycleEvent {
                handoff_id: handoff_id.to_string(),
                status: crate::commands::handoffs::normalize_status(status)
                    .unwrap_or(status)
                    .to_string(),
                agent_id,
                note,
                created_at: chrono::Utc::now().to_rfc3339(),
            });
            while team.handoff_events.len() > 50 {
                let _ = team.handoff_events.pop_front();
            }
        }
        self.persist_team_state(team_id).await
    }
}

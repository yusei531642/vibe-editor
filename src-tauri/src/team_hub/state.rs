#[cfg(unix)]
use super::bind_local_listener;
use super::error::{AckError, AckFailPhase};
use super::{bridge, handle_client, hex_encode, TeamHub, MAX_CONCURRENT_CLIENTS};
#[cfg(windows)]
use super::{create_pipe_server, new_pipe_endpoint};
use crate::commands::team_history::HandoffReference;
use crate::commands::team_state::{
    FileLockConflictSnapshot, HandoffLifecycleEvent, HumanGateState, TaskDoneEvidenceSnapshot,
    TaskPreApprovalSnapshot, TeamOrchestrationState, TeamReportSnapshot, TeamTaskSnapshot,
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
use std::time::{Duration, Instant};
use tauri::Emitter;
use tokio::sync::{oneshot, Mutex, OwnedSemaphorePermit, Semaphore};
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
    ///
    /// Issue #637: key を `(team_id, agent_id)` の tuple に拡張。同一 `agent_id` が
    /// 別 team で再 handshake された場合に古い team の binding を上書きしないよう、
    /// team 次元を持たせる (cross-team で role 上書きの race を遮断)。
    /// in-memory only (Hub 再起動で全 clear)、永続化レイヤーは無いので migration 不要。
    pub(crate) agent_role_bindings: HashMap<(String, String), String>,
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
    /// Issue #576: team_id ごとの「同時 recruit / create_leader 件数」を直列化する semaphore。
    /// `team_recruit` / `team_create_leader` の冒頭で `acquire_recruit_permit` を呼んで permit を
    /// 取得し、permit 保持のまま emit → ack 受領 (or timeout) → `cancel_pending_recruit` までを
    /// 1 クリティカルセクションに包む。permit は team_id 単位で独立 (異なる team_id は別 Semaphore)
    /// なので、cross-team では並列に進行する。Hub 再起動で全 clear (in-memory only)。
    /// permit 数は `VIBE_TEAM_RECRUIT_CONCURRENCY` 環境変数で `1..=RECRUIT_MAX_CONCURRENCY` の
    /// 範囲に tunable (既定 `RECRUIT_DEFAULT_CONCURRENCY`)。team 単位で lazy 初期化される。
    pub(crate) recruit_semaphores: HashMap<String, Arc<Semaphore>>,
    /// Issue #634: `team_status` の rate limit 用、agent_id → 最終呼び出し Instant。
    /// `MIN_STATUS_INTERVAL` 以内の連続呼び出しは silent reject し、
    /// `last_status_at` / `last_seen_at` も更新しない (autoStale 偽装防止)。
    /// in-memory only (Hub 再起動で clear)。
    pub(crate) last_status_call_at: HashMap<String, std::time::Instant>,
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

const RECRUIT_GRACE_DEFAULT_MS: u64 = 2_000;
const RECRUIT_GRACE_MAX_MS: u64 = 10_000;

#[cfg(test)]
static RECRUIT_RESCUED_EVENTS_FOR_TEST: once_cell::sync::Lazy<
    std::sync::Mutex<Vec<RecruitRescuedPayload>>,
> = once_cell::sync::Lazy::new(|| std::sync::Mutex::new(Vec::new()));

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
    /// Issue #577: ack timeout 済みだが grace window 中で、遅着 ack を rescue できる状態。
    pub timed_out_at: Option<Instant>,
}

/// Issue #577: timeout 後 grace 期間中に遅着 ack を救済したことを renderer に知らせる event payload。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecruitRescuedPayload {
    pub new_agent_id: String,
    pub late_by_ms: u64,
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
    /// Issue #572: `team_report` で受け取った構造化レポートのバックログ。FIFO 50 件で上限。
    pub team_reports: VecDeque<TeamReportSnapshot>,
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
    /// Issue #518: チーム単位の engine policy。`team_recruit` で engine 指定が
    /// policy に反する場合は構造化エラー (`recruit_engine_policy_violation`) で拒否する。
    /// 未設定 / レガシー team の既定は `MixedAllowed` (後方互換)。
    pub engine_policy: EnginePolicy,
}

/// Issue #518: チーム単位の engine policy。`MixedAllowed` (既定) で従来通り、
/// `ClaudeOnly` / `CodexOnly` で Codex-only / same-engine ルールを構造的に強制する。
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnginePolicy {
    pub kind: EnginePolicyKind,
    /// チームの既定 engine ("claude" | "codex")。`recruit` で engine 引数が省略された
    /// ときに使われる。`ClaudeOnly` / `CodexOnly` では実質固定だが、`MixedAllowed` のときも
    /// 「混合は許すが既定はこっち」と明示できる。**未設定 (`None`)** なら role profile の
    /// default を使うので、TS 側でも `defaultEngine?: 'claude' | 'codex'` (undefined OK) として
    /// 「未設定」と「空文字明示」を区別しない (= 空文字は許容しない)。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_engine: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EnginePolicyKind {
    /// 既定: claude / codex の混在を許可。レガシー team もこの扱い (後方互換)。
    #[default]
    MixedAllowed,
    /// チーム全体で Claude のみを許可。`engine: "codex"` の recruit は拒否。
    ClaudeOnly,
    /// チーム全体で Codex のみを許可。`engine: "claude"` の recruit は拒否。
    /// HR 経由採用で Codex 指定が消えて Claude にリセットされる事故を構造的に消す。
    CodexOnly,
}

impl EnginePolicy {
    /// `engine` (claude / codex) が本 policy に違反していれば人間可読なエラーメッセージを返す。
    /// 違反が無ければ `Ok(())`。
    pub fn validate(&self, engine: &str) -> Result<(), String> {
        match (self.kind, engine) {
            (EnginePolicyKind::ClaudeOnly, "codex") => Err(format!(
                "team engine policy is ClaudeOnly, cannot recruit with engine='codex'"
            )),
            (EnginePolicyKind::CodexOnly, "claude") => Err(format!(
                "team engine policy is CodexOnly, cannot recruit with engine='claude' \
                 (this prevents accidental Claude recruitment into a Codex-only team)"
            )),
            _ => Ok(()),
        }
    }

    /// `engine` 引数省略時に採用する engine 名を返す。
    /// `ClaudeOnly` → "claude" / `CodexOnly` → "codex" / `MixedAllowed` →
    /// `self.default_engine` が `Some` ならそれ、`None` なら `role_default`。
    pub fn resolve_default_engine(&self, role_default: &str) -> String {
        match self.kind {
            EnginePolicyKind::ClaudeOnly => "claude".to_string(),
            EnginePolicyKind::CodexOnly => "codex".to_string(),
            EnginePolicyKind::MixedAllowed => self
                .default_engine
                .clone()
                .unwrap_or_else(|| role_default.to_string()),
        }
    }

    /// 「明示的な policy が設定されているか」を bool で返す (将来の info/UI 拡張で扱う)。
    /// 現在は MCP API 経由の caller が居ないので `#[allow(dead_code)]`。
    #[allow(dead_code)]
    pub fn is_explicit(&self) -> bool {
        !matches!(self.kind, EnginePolicyKind::MixedAllowed) || self.default_engine.is_some()
    }
}

#[derive(Clone)]
pub struct TeamMessage {
    pub id: u32,
    pub from: String,
    pub from_agent_id: String,
    pub to: String,
    /// Issue #515: worker 間メッセージの意味。`advisory` は相談、`request` は正式依頼、
    /// `report` は完了・進捗報告。配送先解決と UI / read payload の両方で使う。
    pub kind: String,
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
    pub target_paths: Vec<String>,
    pub lock_conflicts: Vec<FileLockConflictSnapshot>,
    pub pre_approval: Option<TaskPreApprovalSnapshot>,
    pub done_criteria: Vec<String>,
    pub done_evidence: Vec<TaskDoneEvidenceSnapshot>,
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
            target_paths: self.target_paths.clone(),
            lock_conflicts: self.lock_conflicts.clone(),
            pre_approval: self.pre_approval.clone(),
            done_criteria: self.done_criteria.clone(),
            done_evidence: self.done_evidence.clone(),
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
            target_paths: snapshot.target_paths,
            lock_conflicts: snapshot.lock_conflicts,
            pre_approval: snapshot.pre_approval,
            done_criteria: snapshot.done_criteria,
            done_evidence: snapshot.done_evidence,
        }
    }
}

#[cfg(test)]
mod task_snapshot_tests {
    use super::TeamTask;
    use crate::commands::team_state::{
        FileLockConflictSnapshot, TaskDoneEvidenceSnapshot, TaskPreApprovalSnapshot,
    };

    #[test]
    fn team_task_snapshot_roundtrips_file_ownership_fields() {
        let task = TeamTask {
            id: 525,
            assigned_to: "worker".into(),
            description: "touch shared file".into(),
            status: "pending".into(),
            created_by: "leader".into(),
            created_at: "2026-05-08T00:00:00Z".into(),
            updated_at: None,
            summary: None,
            blocked_reason: None,
            next_action: None,
            artifact_path: None,
            blocked_by_human_gate: false,
            required_human_decision: None,
            target_paths: vec!["src/foo.rs".into()],
            lock_conflicts: vec![FileLockConflictSnapshot {
                path: "src/foo.rs".into(),
                holder_agent_id: "agent-a".into(),
                holder_role: "programmer".into(),
                acquired_at: "2026-05-08T00:01:00Z".into(),
            }],
            pre_approval: Some(TaskPreApprovalSnapshot {
                allowed_actions: vec!["read docs".into()],
                note: Some("lightweight investigation only".into()),
            }),
            done_criteria: vec!["focused test passes".into()],
            done_evidence: vec![TaskDoneEvidenceSnapshot {
                criterion: "focused test passes".into(),
                evidence: "cargo test assign_task --lib passed".into(),
            }],
        };

        let snapshot = task.to_snapshot();
        assert_eq!(snapshot.target_paths, vec!["src/foo.rs"]);
        assert_eq!(snapshot.lock_conflicts.len(), 1);
        assert_eq!(snapshot.lock_conflicts[0].holder_agent_id, "agent-a");
        assert_eq!(
            snapshot
                .pre_approval
                .as_ref()
                .expect("pre approval snapshot")
                .allowed_actions,
            vec!["read docs"]
        );
        assert_eq!(snapshot.done_criteria, vec!["focused test passes"]);
        assert_eq!(snapshot.done_evidence[0].criterion, "focused test passes");

        let restored = TeamTask::from_snapshot(snapshot);
        assert_eq!(restored.target_paths, vec!["src/foo.rs"]);
        assert_eq!(restored.lock_conflicts.len(), 1);
        assert_eq!(restored.lock_conflicts[0].path, "src/foo.rs");
        assert_eq!(
            restored
                .pre_approval
                .as_ref()
                .expect("pre approval")
                .note
                .as_deref(),
            Some("lightweight investigation only")
        );
        assert_eq!(restored.done_criteria, vec!["focused test passes"]);
        assert_eq!(
            restored.done_evidence[0].evidence,
            "cargo test assign_task --lib passed"
        );
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
        Self::with_inflight(registry, crate::pty::InFlightTracker::new())
    }

    /// Issue #630: AppState 側で生成した in-flight tracker を共有する用。
    /// `AppState::new()` から呼ばれる。
    pub fn with_inflight(
        registry: Arc<SessionRegistry>,
        inflight: Arc<crate::pty::InFlightTracker>,
    ) -> Self {
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
                recruit_semaphores: HashMap::new(),
                last_status_call_at: HashMap::new(),
            })),
            app_handle: Arc::new(Mutex::new(None)),
            inflight,
        }
    }

    // ===== Issue #526: file lock helpers (TeamHub method 経由で HubState の file_locks を操作) =====

    /// Issue #599 (Tier A-1): team あたりの lock 数 cap を atomic に enforce しつつ acquire する。
    /// HubState の Mutex を 1 セッションだけ取って count → cap check → try_acquire を完結させる
    /// (= count と insert の間に別 agent が割り込んで cap を踏み越える race を排除)。
    pub async fn try_acquire_file_locks_with_cap(
        &self,
        team_id: &str,
        agent_id: &str,
        role: &str,
        paths: &[String],
        cap: usize,
    ) -> Result<crate::team_hub::file_locks::LockResult, crate::team_hub::file_locks::FileLockCapExceeded>
    {
        let mut s = self.state.lock().await;
        crate::team_hub::file_locks::try_acquire_with_cap(
            &mut s.file_locks,
            team_id,
            agent_id,
            role,
            paths,
            cap,
        )
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
    pub async fn release_all_file_locks_for_agent(&self, team_id: &str, agent_id: &str) -> u32 {
        let mut s = self.state.lock().await;
        crate::team_hub::file_locks::release_all_for_agent(&mut s.file_locks, team_id, agent_id)
    }

    /// Issue #637: dismiss された (team_id, agent_id) の role binding を取り除く。
    /// 取り除かないと「dismiss 済 worker の role 文字列」がメモリに残り続け、
    /// 同 agent_id を別 role で再 recruit したい時に role mismatch で接続拒否される。
    /// 別 team の binding は team_id 次元で分離されているので影響しない。
    pub async fn remove_agent_role_binding(&self, team_id: &str, agent_id: &str) -> bool {
        let mut s = self.state.lock().await;
        s.agent_role_bindings
            .remove(&(team_id.to_string(), agent_id.to_string()))
            .is_some()
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

    // ===== Issue #518: engine policy helpers =====

    /// `team_id` の現在の engine policy を返す。team が未登録 / 未設定なら既定 `MixedAllowed`。
    pub async fn get_engine_policy(&self, team_id: &str) -> EnginePolicy {
        let s = self.state.lock().await;
        s.teams
            .get(team_id)
            .map(|t| t.engine_policy.clone())
            .unwrap_or_default()
    }

    /// `team_id` の engine policy を上書きする。team entry が無ければ作成する。
    /// 主に `team_create_leader` (チーム作成 / leader 引き継ぎ) で呼ばれる。
    pub async fn set_engine_policy(&self, team_id: &str, policy: EnginePolicy) {
        let mut s = self.state.lock().await;
        let team = s
            .teams
            .entry(team_id.to_string())
            .or_insert_with(TeamInfo::default);
        team.engine_policy = policy;
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
                timed_out_at: None,
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
    /// (cross-team 偽 handshake / 旧 context 残骸の混線を防ぐ)。
    ///
    /// Issue #637: `agent_role_bindings` の key を `(team_id, agent_id)` tuple に拡張。
    /// 同 agent_id が別 team で handshake してきても old team の binding を上書きしない
    /// (cross-team race の遮断)。lookup / insert は team_id ペアで行う。
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
        // 既に bind 済みの (team_id, agent_id) なら role 一致を強制。
        // Issue #637: team_id 次元で分離しているので、別 team の同 agent_id binding は
        // この lookup に引っかからず、上書きで old team の role が消えることもない。
        let binding_key = (team_id.to_string(), agent_id.to_string());
        if let Some(bound) = s.agent_role_bindings.get(&binding_key) {
            if bound != role_profile_id {
                tracing::warn!(
                    "[teamhub] role mismatch on handshake (rebind) team={} agent={} bound={} got={}",
                    team_id,
                    agent_id,
                    bound,
                    role_profile_id
                );
                return false;
            }
        } else {
            // 初回 handshake で bind
            s.agent_role_bindings
                .insert(binding_key, role_profile_id.to_string());
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

    /// timeout 等でキャンセル: ack channel は即時 close しつつ、短い grace window 中は
    /// pending を残して renderer からの遅着 ack を rescue できるようにする (Issue #577)。
    pub async fn cancel_pending_recruit(&self, agent_id: &str) {
        self.cancel_pending_recruit_with_grace(agent_id, recruit_grace_from_env())
            .await;
    }

    async fn cancel_pending_recruit_with_grace(&self, agent_id: &str, grace: Duration) {
        let timed_out_at = Instant::now();
        let should_schedule_cleanup = {
            let mut s = self.state.lock().await;
            let Some(pending) = s.pending_recruits.get_mut(agent_id) else {
                return;
            };

            // 既に timeout 済みなら idempotent に扱う。重複 cleanup task を増やさない。
            if pending.timed_out_at.is_some() {
                return;
            }

            // ack waiter には従来どおり Err を返すため、ack_tx は timeout 時点で close する。
            let _ = pending.ack_tx.take();

            if grace.is_zero() {
                // VIBE_TEAM_RECRUIT_GRACE_MS=0 は旧挙動互換: 即時に pending を破棄する。
                s.pending_recruits.remove(agent_id);
                false
            } else {
                pending.timed_out_at = Some(timed_out_at);
                true
            }
        };

        if should_schedule_cleanup {
            let hub = self.clone();
            let agent_id = agent_id.to_string();
            tokio::spawn(async move {
                tokio::time::sleep(grace).await;
                let mut s = hub.state.lock().await;
                let should_remove = s
                    .pending_recruits
                    .get(&agent_id)
                    .and_then(|p| p.timed_out_at)
                    .is_some_and(|ts| ts == timed_out_at);
                if should_remove {
                    s.pending_recruits.remove(&agent_id);
                }
            });
        }
    }

    /// Issue #576: team 単位の同時 recruit permit を取得する。
    ///
    /// `team_id` 単位で初回呼び出し時に lazy 初期化される `tokio::sync::Semaphore` から
    /// `acquire_owned()` で permit を要求する。permit は `OwnedSemaphorePermit` の Drop で
    /// 自動解放されるため、`team_recruit` / `team_create_leader` 側では
    /// `let _permit = hub.acquire_recruit_permit(...).await?;` で関数末尾まで束ねれば、
    /// 正常終了 / `?` での早期 return / panic / future cancel いずれでも自動で解放される。
    ///
    /// permit 数は `VIBE_TEAM_RECRUIT_CONCURRENCY` 環境変数で `1..=RECRUIT_MAX_CONCURRENCY`
    /// の範囲に上書きできる (範囲外 / parse 失敗時は `RECRUIT_DEFAULT_CONCURRENCY`)。
    /// 値は `team_id` ごとの初回 acquire 時に確定し、その後の env 変更では再評価しない
    /// (= 起動時にのみ調整する想定)。
    ///
    /// permit 取得待ちが長引いて caller (MCP client) が timeout するのを避けるため、
    /// 既存 `RECRUIT_TIMEOUT` (30s) と同水準の上限を取得側にも入れている。
    ///
    /// 戻り値の `Err(String)` は **人間可読メッセージのみ** を含む (= `"recruit_permit_timeout"`
    /// 等の error code prefix は付けない)。caller 側で `RecruitError::new("recruit_permit_timeout",
    /// msg)` 等でラップして flat JSON `{ "code": ..., "message": ..., "phase": ... }` に
    /// シリアライズする責務を持たせる。これにより renderer が `code` で機械的に分岐する際に
    /// `code` 文字列が `message` に重複混入するのを避ける (PR #583 review より)。
    pub async fn acquire_recruit_permit(
        &self,
        team_id: &str,
    ) -> Result<OwnedSemaphorePermit, String> {
        // semaphore の lookup / 挿入だけ HubState lock 内で済ませ、その後の `acquire_owned`
        // はロック外で行う (acquire 側で他の HubState 操作と競合しないように)。
        //
        // Issue #589: lazy init で 1 回だけ tracing log を出す。env を変えたのに反映されない
        // 相談時に、起動ログから実際の permit 数を確認できるようにする。
        // - 範囲内 env override → info "source=env"
        // - env 未設定 (= default 採用) → info "source=default"
        // - env 設定済みだが parse 失敗 / 範囲外で default にフォールバック → warn "source=fallback"
        let semaphore = {
            let mut s = self.state.lock().await;
            if let Some(existing) = s.recruit_semaphores.get(team_id) {
                existing.clone()
            } else {
                let (permits, source) = recruit_concurrency_from_env_with_source();
                if matches!(source, RecruitConcurrencySource::InvalidEnvFallback) {
                    tracing::warn!(
                        "[teamhub] recruit semaphore initialized: team={team_id} permits={permits} source={source}",
                        source = source.label(),
                    );
                } else {
                    tracing::info!(
                        "[teamhub] recruit semaphore initialized: team={team_id} permits={permits} source={source}",
                        source = source.label(),
                    );
                }
                let sem = Arc::new(Semaphore::new(permits));
                s.recruit_semaphores
                    .insert(team_id.to_string(), sem.clone());
                sem
            }
        };
        let timeout = crate::team_hub::protocol::consts::RECRUIT_TIMEOUT;
        match tokio::time::timeout(timeout, semaphore.acquire_owned()).await {
            Ok(Ok(permit)) => Ok(permit),
            Ok(Err(_closed)) => Err(format!(
                "recruit semaphore for team_id={team_id} was closed"
            )),
            Err(_) => Err(format!(
                "could not acquire a recruit permit for team_id={team_id} within {}s \
                 (concurrency saturated)",
                timeout.as_secs()
            )),
        }
    }

    /// テスト専用: 指定 `team_id` の recruit semaphore を任意の permit 数で初期化 (or 置換)。
    /// `acquire_recruit_permit` の lazy init をスキップして permit 数を直接指定したいときに使う。
    #[cfg(test)]
    pub(crate) async fn set_recruit_concurrency_for_test(&self, team_id: &str, permits: usize) {
        let mut s = self.state.lock().await;
        s.recruit_semaphores
            .insert(team_id.to_string(), Arc::new(Semaphore::new(permits)));
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
            // Issue #574: ack_timeout 後の遅着 ack は設計上の正常現象 (cancel_pending_recruit が
            // pending を完全削除した後で renderer が ack invoke を届けるパス) なので、
            // warn → info に降格してアラート noise を減らす。agent_id / team_id / reason は
            // 構造化キーで出して grep / 集計しやすくする。
            tracing::info!(
                "[teamhub] recruit_ack ignored agent_id={agent_id} team_id={expected_team_id} \
                 reason=no_pending_recruit"
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
        if let Some(timed_out_at) = pending.timed_out_at {
            // timeout 後 grace 中の遅着 ack。ack waiter は既に close 済みなので送信せず、
            // renderer 側へ rescue event を出してカード維持を観測可能にする。
            let _ = pending.ack_tx.take();
            let late_by_ms = timed_out_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
            let payload = RecruitRescuedPayload {
                new_agent_id: agent_id.to_string(),
                late_by_ms,
            };
            drop(s);
            tracing::info!(
                "[teamhub] recruit_ack rescued agent={} late_by_ms={}",
                agent_id,
                late_by_ms
            );
            self.emit_recruit_rescued(payload).await;
            return Ok(());
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

    async fn emit_recruit_rescued(&self, payload: RecruitRescuedPayload) {
        #[cfg(test)]
        {
            RECRUIT_RESCUED_EVENTS_FOR_TEST
                .lock()
                .expect("recruit rescued test event mutex poisoned")
                .push(payload.clone());
        }

        let app = self.app_handle.lock().await.clone();
        if let Some(app) = app {
            if let Err(err) = app.emit("team:recruit-rescued", payload) {
                tracing::warn!("[teamhub] failed to emit recruit-rescued event: {err}");
            }
        }
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
                    // Issue #603 (Security): peer UID 検証 — token 一致だけでは認可しない。
                    // 同 user の任意プロセスからの token 盗み見 + 接続を別 user 越境からは塞ぐ。
                    if let Err(e) = crate::team_hub::check_peer_is_self_unix(&sock) {
                        tracing::warn!(
                            "[teamhub] peer credential check failed, dropping connection: {e:#}"
                        );
                        drop(sock);
                        continue;
                    }
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
                    // Issue #603 (Security): peer SID 検証 — token 一致だけでは認可しない。
                    // 同 user の任意プロセスからの token 盗み見 + 接続を別 user 越境からは塞ぐ。
                    if let Err(e) = crate::team_hub::check_peer_is_self_windows(&connected) {
                        tracing::warn!(
                            "[teamhub] peer credential check failed, dropping connection: {e:#}"
                        );
                        drop(connected);
                        continue;
                    }
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
        // Issue #513: ~/.vibe-editor/role-profiles.json#dynamic[] から該当 team_id の entry を抽出。
        // role-profiles.json は user-global (project_root 非依存) なので、project_root の有無に
        // 関わらず実行する。読み込み失敗 / 古い JSON (dynamic フィールドなし) は空配列扱い。
        // state.lock の前に async I/O を済ませ、lock を保持中に file read をしないようにしている。
        let persisted_dynamic_entries = load_persisted_dynamic_for_team(team_id).await;

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
            // Issue #572: `team_report` 由来の構造化レポート backlog を永続化から復元する。
            // worker_reports と独立した channel として持つ (= structured report の意味的分離)。
            if team.team_reports.is_empty() {
                team.team_reports = persisted.team_reports.into_iter().collect();
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
        drop(s);
        // Issue #513: state.lock を drop した後で `replay_persisted_dynamic_roles_for_team` を呼ぶ。
        // この関数は内部で hub.state.lock() を取るので、外側 lock を保持したまま呼ぶと deadlock する。
        // 永続化が空 (entry 0 件) のチームは `replace_dynamic_roles` で空集合を投入することになるが、
        // 既存 in-memory が空のままなら no-op、既存に entry が居れば「永続化済 = 真の状態」として
        // 完全置換する設計 (= renderer 側 cache が永続化と乖離していた場合に永続化を勝者とする)。
        if !persisted_dynamic_entries.is_empty() {
            let skipped =
                crate::team_hub::protocol::dynamic_role::replay_persisted_dynamic_roles_for_team(
                    self,
                    team_id,
                    persisted_dynamic_entries,
                )
                .await;
            if skipped > 0 {
                tracing::warn!(
                    "[register_team] team={team_id}: {skipped} persisted dynamic entries skipped (expired / mismatch)"
                );
            }
        }

        // Issue #512: チーム登録ごとに `<project_root>/.vibe-team/tmp/` の古い spool ファイルを
        // best-effort で cleanup する。アプリ起動時のみだと長時間 session で TTL 超過が発生し続ける
        // ため、register_team (= setup MCP 経路) ごとに 1 回だけ走らせる。fire-and-forget で
        // register_team の戻りを遅延させない。
        if let Some(root) = project_root.map(str::trim).filter(|p| !p.is_empty()) {
            let root_owned = root.to_string();
            tokio::spawn(async move {
                crate::team_hub::spool::cleanup_old_spools(&root_owned).await;
            });
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
                // Issue #572: `team_report` 由来の構造化レポート backlog を永続化対象に含める。
                team_reports: team.team_reports.iter().cloned().collect(),
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

/// Issue #589: `recruit_concurrency_from_env_with_source` の戻り値。permit 数の選択経路を
/// 区別して、lazy init 時のログレベル (info / warn) を切り替えるために使う。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RecruitConcurrencySource {
    /// `VIBE_TEAM_RECRUIT_CONCURRENCY` が `1..=RECRUIT_MAX_CONCURRENCY` の範囲内で設定済み。
    Env,
    /// `VIBE_TEAM_RECRUIT_CONCURRENCY` が未設定 (= 通常運用)。
    Default,
    /// `VIBE_TEAM_RECRUIT_CONCURRENCY` は設定されているが parse 失敗 / 範囲外で
    /// `RECRUIT_DEFAULT_CONCURRENCY` にフォールバックした (= 設定ミスの可能性)。
    InvalidEnvFallback,
}

impl RecruitConcurrencySource {
    fn label(self) -> &'static str {
        match self {
            Self::Env => "env",
            Self::Default => "default",
            Self::InvalidEnvFallback => "fallback",
        }
    }
}

/// Issue #576 / #589: `VIBE_TEAM_RECRUIT_CONCURRENCY` 環境変数を読んで permit 数を決め、
/// その決定経路 (env override / default / 範囲外 fallback) も併せて返す。
///
/// `1..=RECRUIT_MAX_CONCURRENCY` の範囲外・parse 失敗は `RECRUIT_DEFAULT_CONCURRENCY` に
/// フォールバックし、`InvalidEnvFallback` を返す。未設定は `Default`、範囲内 override は
/// `Env`。lazy init log の info / warn 分岐にこの source を使う (Issue #589)。
///
/// `acquire_recruit_permit` の lazy 初期化時に team_id ごとに 1 度だけ呼ばれる想定なので、
/// env を読むオーバーヘッドは無視できる。
fn recruit_concurrency_from_env_with_source() -> (usize, RecruitConcurrencySource) {
    use crate::team_hub::protocol::consts::{RECRUIT_DEFAULT_CONCURRENCY, RECRUIT_MAX_CONCURRENCY};
    match std::env::var("VIBE_TEAM_RECRUIT_CONCURRENCY") {
        Err(_) => (RECRUIT_DEFAULT_CONCURRENCY, RecruitConcurrencySource::Default),
        Ok(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return (RECRUIT_DEFAULT_CONCURRENCY, RecruitConcurrencySource::Default);
            }
            match trimmed.parse::<usize>() {
                Ok(n) if (1..=RECRUIT_MAX_CONCURRENCY).contains(&n) => {
                    (n, RecruitConcurrencySource::Env)
                }
                _ => (
                    RECRUIT_DEFAULT_CONCURRENCY,
                    RecruitConcurrencySource::InvalidEnvFallback,
                ),
            }
        }
    }
}

/// Issue #577: timeout 後に遅着 ack を rescue する grace window。
/// `VIBE_TEAM_RECRUIT_GRACE_MS=0` は旧挙動互換、`>10000` / parse 失敗 / 未設定は default。
fn recruit_grace_from_env() -> Duration {
    let ms = std::env::var("VIBE_TEAM_RECRUIT_GRACE_MS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .filter(|&n| n <= RECRUIT_GRACE_MAX_MS)
        .unwrap_or(RECRUIT_GRACE_DEFAULT_MS);
    Duration::from_millis(ms)
}

/// Issue #513: `~/.vibe-editor/role-profiles.json#dynamic[]` から **指定 team_id に紐付く
/// entry だけ** を抽出して返す内部 helper。`register_team` の前段で呼び、Hub state.lock を
/// 取らずに async I/O を済ませてから replay する設計。
///
/// 失敗時 (file 不在 / parse 失敗 / dynamic フィールドなし) は **空配列** を返す
/// (= 「永続化された動的ロールがない」と意味的に等価)。parse 失敗時は警告ログを残すが、
/// チーム起動自体は失敗させない (= ユーザーが旧 builtin / custom フィールドだけで運用していた
/// 環境で、dynamic フィールドの有無に依存して team が立ち上がらないのを防ぐ)。
///
/// `tokio::fs::read` を使うので state.lock を保持中に呼ばないこと (deadlock はしないが
/// blocking I/O で hub の lock holder time が伸びるため)。
async fn load_persisted_dynamic_for_team(
    team_id: &str,
) -> Vec<crate::team_hub::protocol::dynamic_role::PersistedDynamicRoleEntry> {
    if team_id.trim().is_empty() {
        return Vec::new();
    }
    let path = crate::util::config_paths::role_profiles_path();
    let bytes = match tokio::fs::read(&path).await {
        Ok(b) => b,
        Err(_) => return Vec::new(), // file 不在は normal (初回起動 / 動的ロールを使わない運用)
    };
    let value: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(
                "[register_team] role-profiles.json parse failed when loading dynamic[]: {e}"
            );
            return Vec::new();
        }
    };
    let Some(arr) = value.get("dynamic").and_then(|v| v.as_array()) else {
        // 古い JSON (dynamic フィールドなし) は no-op で OK。新規 save 時に renderer が追加する。
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in arr {
        let entry: crate::team_hub::protocol::dynamic_role::PersistedDynamicRoleEntry =
            match serde_json::from_value(item.clone()) {
                Ok(e) => e,
                Err(e) => {
                    tracing::warn!("[register_team] skipping malformed dynamic[] entry: {e}");
                    continue;
                }
            };
        if entry.team_id == team_id {
            out.push(entry);
        }
    }
    out
}

/// Issue #637: `agent_role_bindings` の `(team_id, agent_id)` 複合キー化を検証する単体テスト。
/// cross-team で同 agent_id が違う role で bind しても old team の binding が保持されること、
/// dismiss で当該 (team_id, agent_id) のみ消えて other team の binding が残ることを検証する。
#[cfg(test)]
mod role_binding_team_id_tests {
    use super::TeamHub;
    use crate::pty::SessionRegistry;
    use std::sync::Arc;

    fn make_hub() -> TeamHub {
        TeamHub::new(Arc::new(SessionRegistry::new()))
    }

    /// 同じ `agent_id` を 2 つの team でそれぞれ違う role として handshake させても、
    /// 各 team の binding は独立に保持される (= cross-team での role 上書きが起きない)。
    #[tokio::test]
    async fn cross_team_same_agent_id_does_not_overwrite_role_binding() {
        let hub = make_hub();
        // team-a で programmer として handshake
        assert!(
            hub.resolve_pending_recruit("agent-1", "team-a", "programmer")
                .await,
            "first handshake on team-a should succeed"
        );
        // team-b で同 agent_id を reviewer として handshake
        assert!(
            hub.resolve_pending_recruit("agent-1", "team-b", "reviewer")
                .await,
            "handshake of same agent_id on a different team should succeed (different binding key)"
        );
        let s = hub.state.lock().await;
        assert_eq!(
            s.agent_role_bindings
                .get(&("team-a".to_string(), "agent-1".to_string())),
            Some(&"programmer".to_string()),
            "team-a binding should keep its original role even after team-b handshake"
        );
        assert_eq!(
            s.agent_role_bindings
                .get(&("team-b".to_string(), "agent-1".to_string())),
            Some(&"reviewer".to_string()),
            "team-b binding should hold the role asserted on team-b handshake"
        );
    }

    /// 同じ team で同 agent_id が違う role で再 handshake してきた場合は
    /// (issue #183 の挙動どおり) false で拒否される。
    #[tokio::test]
    async fn same_team_role_mismatch_on_rehandshake_is_rejected() {
        let hub = make_hub();
        assert!(
            hub.resolve_pending_recruit("agent-1", "team-a", "programmer")
                .await
        );
        assert!(
            !hub.resolve_pending_recruit("agent-1", "team-a", "reviewer")
                .await,
            "rehandshake on same team with conflicting role must be rejected"
        );
    }

    /// `remove_agent_role_binding` は当該 `(team_id, agent_id)` のみ消し、
    /// 別 team の同 agent_id の binding は残す。
    #[tokio::test]
    async fn remove_agent_role_binding_only_targets_specified_team_scope() {
        let hub = make_hub();
        assert!(
            hub.resolve_pending_recruit("agent-1", "team-a", "programmer")
                .await
        );
        assert!(
            hub.resolve_pending_recruit("agent-1", "team-b", "reviewer")
                .await
        );
        let removed = hub.remove_agent_role_binding("team-a", "agent-1").await;
        assert!(removed, "remove should report true when entry existed");

        let s = hub.state.lock().await;
        assert!(
            !s.agent_role_bindings
                .contains_key(&("team-a".to_string(), "agent-1".to_string())),
            "team-a binding should be removed"
        );
        assert_eq!(
            s.agent_role_bindings
                .get(&("team-b".to_string(), "agent-1".to_string())),
            Some(&"reviewer".to_string()),
            "team-b binding for the same agent_id must remain intact"
        );
    }

    /// 存在しない `(team_id, agent_id)` の remove は false を返す (idempotent)。
    #[tokio::test]
    async fn remove_agent_role_binding_returns_false_when_absent() {
        let hub = make_hub();
        let removed = hub
            .remove_agent_role_binding("nonexistent-team", "ghost-agent")
            .await;
        assert!(
            !removed,
            "removing a nonexistent binding should report false without panicking"
        );
    }
}

/// Issue #577: timeout 後 grace 期間中の recruit ack rescue の単体テスト。
#[cfg(test)]
mod recruit_rescue_tests {
    use super::{RecruitAckOutcome, TeamHub, RECRUIT_RESCUED_EVENTS_FOR_TEST};
    use crate::pty::SessionRegistry;
    use crate::team_hub::error::AckError;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio::sync::Barrier;
    use tokio::time::sleep;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn make_hub() -> TeamHub {
        TeamHub::new(Arc::new(SessionRegistry::new()))
    }

    fn ok_ack() -> RecruitAckOutcome {
        RecruitAckOutcome {
            ok: true,
            reason: None,
            phase: None,
        }
    }

    async fn register(hub: &TeamHub, agent_id: &str) -> super::PendingRecruitChannels {
        hub.try_register_pending_recruit(
            agent_id.to_string(),
            "team-a".to_string(),
            "worker".to_string(),
            "leader-a".to_string(),
            false,
            &[],
        )
        .await
        .expect("pending recruit should be registered")
    }

    fn clear_rescue_events() {
        RECRUIT_RESCUED_EVENTS_FOR_TEST
            .lock()
            .expect("recruit rescued test event mutex poisoned")
            .clear();
    }

    fn rescue_events() -> Vec<super::RecruitRescuedPayload> {
        RECRUIT_RESCUED_EVENTS_FOR_TEST
            .lock()
            .expect("recruit rescued test event mutex poisoned")
            .clone()
    }

    #[tokio::test(flavor = "current_thread")]
    async fn timed_out_ack_within_grace_is_rescued_and_emits_event() {
        let _env_guard = ENV_LOCK.lock().expect("env lock poisoned");
        std::env::set_var("VIBE_TEAM_RECRUIT_GRACE_MS", "2000");
        clear_rescue_events();

        let hub = make_hub();
        let channels = register(&hub, "agent-rescue").await;

        hub.cancel_pending_recruit("agent-rescue").await;
        assert!(
            channels.ack.await.is_err(),
            "ack waiter should be closed immediately at timeout"
        );

        sleep(Duration::from_millis(20)).await;
        hub.resolve_recruit_ack("agent-rescue", "team-a", ok_ack())
            .await
            .expect("late ack within grace should be rescued");

        let events = rescue_events();
        assert_eq!(events.len(), 1, "rescue event should be recorded once");
        assert_eq!(events[0].new_agent_id, "agent-rescue");
        assert!(
            events[0].late_by_ms > 0,
            "late_by_ms should record elapsed time after timeout"
        );

        let timed_out = hub
            .state
            .lock()
            .await
            .pending_recruits
            .get("agent-rescue")
            .and_then(|p| p.timed_out_at)
            .is_some();
        assert!(timed_out, "pending should remain during grace window");

        std::env::remove_var("VIBE_TEAM_RECRUIT_GRACE_MS");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn grace_zero_removes_pending_immediately_and_late_ack_is_not_found() {
        let _env_guard = ENV_LOCK.lock().expect("env lock poisoned");
        std::env::set_var("VIBE_TEAM_RECRUIT_GRACE_MS", "0");
        clear_rescue_events();

        let hub = make_hub();
        let channels = register(&hub, "agent-zero").await;

        hub.cancel_pending_recruit("agent-zero").await;
        assert!(
            channels.ack.await.is_err(),
            "ack waiter should be closed immediately"
        );
        assert!(
            !hub.state
                .lock()
                .await
                .pending_recruits
                .contains_key("agent-zero"),
            "grace=0 should preserve the old immediate-remove behavior"
        );

        let err = hub
            .resolve_recruit_ack("agent-zero", "team-a", ok_ack())
            .await
            .expect_err("late ack after immediate removal should be rejected");
        assert!(matches!(err, AckError::NotFound));
        assert!(rescue_events().is_empty());

        std::env::remove_var("VIBE_TEAM_RECRUIT_GRACE_MS");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cancel_and_duplicate_ack_race_is_serialized_by_ack_done() {
        clear_rescue_events();

        let hub = make_hub();
        let _channels = register(&hub, "agent-race").await;
        let barrier = Arc::new(Barrier::new(3));

        let cancel_hub = hub.clone();
        let cancel_barrier = barrier.clone();
        let cancel_task = tokio::spawn(async move {
            cancel_barrier.wait().await;
            cancel_hub
                .cancel_pending_recruit_with_grace("agent-race", Duration::from_millis(2000))
                .await;
        });

        let ack_hub_1 = hub.clone();
        let ack_barrier_1 = barrier.clone();
        let ack_task_1 = tokio::spawn(async move {
            ack_barrier_1.wait().await;
            ack_hub_1
                .resolve_recruit_ack("agent-race", "team-a", ok_ack())
                .await
        });

        let ack_hub_2 = hub.clone();
        let ack_barrier_2 = barrier.clone();
        let ack_task_2 = tokio::spawn(async move {
            ack_barrier_2.wait().await;
            ack_hub_2
                .resolve_recruit_ack("agent-race", "team-a", ok_ack())
                .await
        });

        cancel_task.await.expect("cancel task should not panic");
        let ack_results = [
            ack_task_1.await.expect("ack task 1 should not panic"),
            ack_task_2.await.expect("ack task 2 should not panic"),
        ];

        let ok_count = ack_results.iter().filter(|r| r.is_ok()).count();
        let already_acked_count = ack_results
            .iter()
            .filter(|r| matches!(r, Err(AckError::AlreadyAcked)))
            .count();
        assert_eq!(ok_count, 1, "exactly one ack should win the race");
        assert_eq!(
            already_acked_count, 1,
            "the losing duplicate ack should be rejected by compare_exchange"
        );
        assert!(
            rescue_events().len() <= 1,
            "at most one rescue event should be emitted"
        );
    }
}

/// Issue #576: `acquire_recruit_permit` / `recruit_semaphores` の単体テスト。
///
/// `team_recruit` 全体は renderer (app_handle) 依存なのでここでは結合せず、permit ヘルパ
/// 単独の挙動 — (a) permit=1 で並列 acquire が直列化される、(b) panic / cancel で permit
/// が解放される、(c) 異なる team_id は独立に並列実行できる — を確認する。
#[cfg(test)]
mod recruit_semaphore_tests {
    use super::TeamHub;
    use crate::pty::SessionRegistry;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::time::{sleep, timeout};

    fn make_hub() -> TeamHub {
        TeamHub::new(Arc::new(SessionRegistry::new()))
    }

    /// permit=1 のとき、2 件目の acquire は 1 件目の permit が drop されるまで待つ
    /// (= 同一 team_id の同時 recruit が直列化される)。
    #[tokio::test]
    async fn permit_one_serializes_two_concurrent_acquires() {
        let hub = make_hub();
        hub.set_recruit_concurrency_for_test("team-a", 1).await;

        let permit_a = hub
            .acquire_recruit_permit("team-a")
            .await
            .expect("first acquire should succeed");

        let hub_for_task = hub.clone();
        let handle =
            tokio::spawn(async move { hub_for_task.acquire_recruit_permit("team-a").await });

        // permit_a を握ったまま十分に待つ。直列化されているなら handle は完了しない。
        sleep(Duration::from_millis(150)).await;
        assert!(
            !handle.is_finished(),
            "second acquire must remain pending while first permit is held"
        );

        drop(permit_a);

        let permit_b = timeout(Duration::from_secs(2), handle)
            .await
            .expect("second acquire should complete shortly after first permit drop")
            .expect("spawned task must not panic")
            .expect("second acquire should succeed");
        drop(permit_b);
    }

    /// permit を保持した task が panic で死んでも、`OwnedSemaphorePermit` の Drop で
    /// 解放されるので後続の acquire は即座に成功する。
    #[tokio::test]
    async fn permit_released_when_holder_panics() {
        let hub = make_hub();
        hub.set_recruit_concurrency_for_test("team-b", 1).await;

        let hub_for_task = hub.clone();
        let handle = tokio::spawn(async move {
            let _permit = hub_for_task
                .acquire_recruit_permit("team-b")
                .await
                .expect("inner acquire should succeed");
            panic!("intentional panic to verify permit drop releases the semaphore");
        });

        let join_result = handle.await;
        assert!(
            join_result.is_err() && join_result.err().is_some_and(|e| e.is_panic()),
            "spawned task should have panicked"
        );

        let permit = timeout(Duration::from_secs(1), hub.acquire_recruit_permit("team-b"))
            .await
            .expect("acquire should not time out after holder panic")
            .expect("acquire should succeed once panicked permit is dropped");
        drop(permit);
    }

    /// permit を保持した task の Future を `abort()` (= cancel) しても、Drop で permit が
    /// 解放されるので後続の acquire は即座に成功する。
    #[tokio::test]
    async fn permit_released_when_holder_future_cancelled() {
        let hub = make_hub();
        hub.set_recruit_concurrency_for_test("team-c", 1).await;

        let hub_for_task = hub.clone();
        let handle = tokio::spawn(async move {
            let _permit = hub_for_task
                .acquire_recruit_permit("team-c")
                .await
                .expect("inner acquire should succeed");
            // permit を握ったまま長時間 sleep — abort() で future ごと drop される想定。
            sleep(Duration::from_secs(60)).await;
        });

        // permit が確実に握られるまで少しだけ待つ。
        sleep(Duration::from_millis(50)).await;
        handle.abort();
        let _ = handle.await;

        let permit = timeout(Duration::from_secs(1), hub.acquire_recruit_permit("team-c"))
            .await
            .expect("acquire should not time out after holder cancel")
            .expect("acquire should succeed once cancelled permit is dropped");
        drop(permit);
    }

    /// 異なる team_id は別々の Semaphore を持つので、permit=1 でも cross-team では
    /// 並列に acquire できる (= 無関係の team が待たされない)。
    #[tokio::test]
    async fn different_team_ids_are_independent() {
        let hub = make_hub();
        hub.set_recruit_concurrency_for_test("team-x", 1).await;
        hub.set_recruit_concurrency_for_test("team-y", 1).await;

        let permit_x = hub
            .acquire_recruit_permit("team-x")
            .await
            .expect("team-x acquire should succeed");

        // team-x の permit を握ったままでも、team-y は即座に取れる。
        let permit_y = timeout(Duration::from_secs(1), hub.acquire_recruit_permit("team-y"))
            .await
            .expect("team-y acquire should not be blocked by team-x")
            .expect("team-y acquire should succeed");

        drop(permit_y);
        drop(permit_x);
    }
}

/// Issue #589: `acquire_recruit_permit` の lazy init 時に出力する tracing ログのテスト。
///
/// `tracing::subscriber::with_default` は thread-local で subscriber を差し替えるため、
/// `current_thread` runtime で `block_on` した async コードからも捕捉できる。env を触る
/// テストはプロセス global な VIBE_TEAM_RECRUIT_CONCURRENCY を共有するので Mutex で直列化。
#[cfg(test)]
mod recruit_semaphore_log_tests {
    use super::TeamHub;
    use crate::pty::SessionRegistry;
    use std::io::Write;
    use std::sync::{Arc, Mutex};
    use tracing_subscriber::fmt::MakeWriter;

    static ENV_GUARD: Mutex<()> = Mutex::new(());

    fn make_hub() -> TeamHub {
        TeamHub::new(Arc::new(SessionRegistry::new()))
    }

    #[derive(Clone, Default)]
    struct CapturedWriter(Arc<Mutex<Vec<u8>>>);

    impl Write for CapturedWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'a> MakeWriter<'a> for CapturedWriter {
        type Writer = Self;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    fn capture<F: FnOnce()>(f: F) -> String {
        let writer = CapturedWriter::default();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(writer.clone())
            .with_max_level(tracing::Level::TRACE)
            .with_target(false)
            .with_ansi(false)
            .finish();
        tracing::subscriber::with_default(subscriber, f);
        let buf = writer.0.lock().unwrap().clone();
        String::from_utf8(buf).unwrap_or_default()
    }

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build current_thread runtime")
            .block_on(future)
    }

    /// 初回の `acquire_recruit_permit` で 1 回だけ `recruit semaphore initialized` が
    /// 出力され、2 回目以降の acquire では再出力されない (lazy init 1 回限り)。
    #[test]
    fn lazy_init_log_emitted_only_once_per_team() {
        let _g = ENV_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        std::env::remove_var("VIBE_TEAM_RECRUIT_CONCURRENCY");

        let logs = capture(|| {
            block_on(async {
                let hub = make_hub();
                let p1 = hub
                    .acquire_recruit_permit("team-init-once")
                    .await
                    .expect("first acquire should succeed");
                drop(p1);
                let p2 = hub
                    .acquire_recruit_permit("team-init-once")
                    .await
                    .expect("second acquire should succeed");
                drop(p2);
            });
        });

        let init_count = logs.matches("recruit semaphore initialized").count();
        assert_eq!(
            init_count, 1,
            "expected exactly 1 init log across 2 acquires; got: {logs}",
        );
        assert!(
            logs.contains("team=team-init-once"),
            "init log should include team_id; got: {logs}",
        );
        assert!(
            logs.contains("source=default"),
            "unset env should be logged as source=default; got: {logs}",
        );
        assert!(
            logs.contains("INFO"),
            "default source should be info-level; got: {logs}",
        );
    }

    /// 範囲内 env override (`VIBE_TEAM_RECRUIT_CONCURRENCY=4`) は info で `source=env`。
    #[test]
    fn lazy_init_log_with_valid_env_uses_info_and_marks_env() {
        let _g = ENV_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("VIBE_TEAM_RECRUIT_CONCURRENCY", "4");

        let logs = capture(|| {
            block_on(async {
                let hub = make_hub();
                let p = hub
                    .acquire_recruit_permit("team-init-env")
                    .await
                    .expect("acquire should succeed");
                drop(p);
            });
        });

        std::env::remove_var("VIBE_TEAM_RECRUIT_CONCURRENCY");

        assert!(
            logs.contains("recruit semaphore initialized"),
            "expected init log; got: {logs}",
        );
        assert!(
            logs.contains("source=env"),
            "in-range env should be logged as source=env; got: {logs}",
        );
        assert!(
            logs.contains("permits=4"),
            "permits should reflect env value; got: {logs}",
        );
        assert!(
            logs.contains("INFO"),
            "valid env should be info-level; got: {logs}",
        );
    }

    /// 範囲外 env (= `VIBE_TEAM_RECRUIT_CONCURRENCY=999`) は warn で `source=fallback`。
    #[test]
    fn lazy_init_log_with_invalid_env_uses_warn_and_marks_fallback() {
        let _g = ENV_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("VIBE_TEAM_RECRUIT_CONCURRENCY", "999");

        let logs = capture(|| {
            block_on(async {
                let hub = make_hub();
                let p = hub
                    .acquire_recruit_permit("team-init-bad")
                    .await
                    .expect("acquire should still succeed (default fallback)");
                drop(p);
            });
        });

        std::env::remove_var("VIBE_TEAM_RECRUIT_CONCURRENCY");

        assert!(
            logs.contains("recruit semaphore initialized"),
            "expected init log; got: {logs}",
        );
        assert!(
            logs.contains("source=fallback"),
            "out-of-range env should be logged as source=fallback; got: {logs}",
        );
        assert!(
            logs.contains("WARN"),
            "out-of-range env should be warn-level; got: {logs}",
        );
    }

    /// parse 失敗 (= `VIBE_TEAM_RECRUIT_CONCURRENCY=not-a-number`) も warn + fallback。
    #[test]
    fn lazy_init_log_with_unparseable_env_uses_warn_and_marks_fallback() {
        let _g = ENV_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("VIBE_TEAM_RECRUIT_CONCURRENCY", "not-a-number");

        let logs = capture(|| {
            block_on(async {
                let hub = make_hub();
                let p = hub
                    .acquire_recruit_permit("team-init-garbage")
                    .await
                    .expect("acquire should still succeed (default fallback)");
                drop(p);
            });
        });

        std::env::remove_var("VIBE_TEAM_RECRUIT_CONCURRENCY");

        assert!(
            logs.contains("source=fallback"),
            "unparseable env should be logged as source=fallback; got: {logs}",
        );
        assert!(
            logs.contains("WARN"),
            "unparseable env should be warn-level; got: {logs}",
        );
    }
}

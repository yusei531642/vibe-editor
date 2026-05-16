//! `HubState` struct と TeamHub の in-memory データ型、コンストラクタ、
//! サーバーライフサイクル (`start` / `info` / `set_app_handle`)。
//!
//! Issue #736: 旧 `state.rs` から「状態 struct + 型定義 + ライフサイクル」を切り出し。

use crate::commands::team_history::HandoffReference;
use crate::commands::team_state::{
    FileLockConflictSnapshot, HandoffLifecycleEvent, HumanGateState, TaskDoneEvidenceSnapshot,
    TaskPreApprovalSnapshot, TeamReportSnapshot, TeamTaskSnapshot, WorkerReportSnapshot,
};
use crate::pty::SessionRegistry;
use crate::team_hub::{bridge, TeamHub};
use anyhow::Result;
use once_cell::sync::OnceCell;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{Mutex, Semaphore};

use super::member_diagnostics::MemberDiagnostics;
use super::recruit::PendingRecruit;

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

/// Claude CLI の `No conversation found with session ID: ...` 行から session id を抽出する。
/// `team_hub::state::member_diagnostics` の `record_agent_process_exit` から参照する。
pub(super) fn extract_no_conversation_session_id(output_tail: &str) -> Option<String> {
    const MARKER: &str = "No conversation found with session ID:";
    let idx = output_tail.rfind(MARKER)?;
    let rest = output_tail[idx + MARKER.len()..].trim_start();
    let session_id: String = rest
        .chars()
        .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .collect();
    if session_id.is_empty() {
        None
    } else {
        Some(session_id)
    }
}

#[cfg(test)]
mod path_tests {
    use super::{extract_no_conversation_session_id, reduce_home_prefix};

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

    #[test]
    fn extracts_no_conversation_session_id_from_tail() {
        let tail = "\r\nNo conversation found with session ID: f45f9cf8-eddc-4e70-a5a9-d4d2e6aa0ef9\r\n[process exited]";
        assert_eq!(
            extract_no_conversation_session_id(tail).as_deref(),
            Some("f45f9cf8-eddc-4e70-a5a9-d4d2e6aa0ef9")
        );
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
        state.token = crate::team_hub::hex_encode(&buf);

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
            let (listener, endpoint) = crate::team_hub::bind_local_listener().await?;
            state.endpoint = endpoint.clone();
            drop(state);

            let sem = Arc::new(Semaphore::new(crate::team_hub::MAX_CONCURRENT_CLIENTS));
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
                                crate::team_hub::MAX_CONCURRENT_CLIENTS
                            );
                            drop(sock);
                            continue;
                        }
                    };
                    let hub2 = hub.clone();
                    let token = token.clone();
                    tokio::spawn(async move {
                        let _permit = permit;
                        if let Err(e) = crate::team_hub::handle_client(hub2, sock, token).await {
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
            let endpoint = crate::team_hub::new_pipe_endpoint();
            let mut listener = crate::team_hub::create_pipe_server(&endpoint, true)?;
            state.endpoint = endpoint.clone();
            drop(state);

            let sem = Arc::new(Semaphore::new(crate::team_hub::MAX_CONCURRENT_CLIENTS));
            let hub = self.clone();
            let endpoint_for_loop = endpoint.clone();
            tokio::spawn(async move {
                loop {
                    if let Err(e) = listener.connect().await {
                        tracing::warn!("teamhub pipe connect failed: {e}");
                        break;
                    }
                    let connected = listener;
                    listener = match crate::team_hub::create_pipe_server(&endpoint_for_loop, false)
                    {
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
                            crate::team_hub::MAX_CONCURRENT_CLIENTS
                        );
                        drop(connected);
                        continue;
                    };
                    let hub2 = hub.clone();
                    let token = token.clone();
                    tokio::spawn(async move {
                        let _permit = permit;
                        if let Err(e) =
                            crate::team_hub::handle_client(hub2, connected, token).await
                        {
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
}

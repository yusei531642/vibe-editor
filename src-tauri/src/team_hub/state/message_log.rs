//! Issue #1071: team メッセージ列 (`TeamMessage`) と既読状態 (`read_by` / `delivered_at`) +
//! `next_message_id` の永続化 (agmsg 由来 / Phase 1)。
//!
//! # 背景
//! `TeamInfo.tasks` / `worker_reports` / `team_reports` / `handoff_events` 等は
//! `persist_team_state` (#470) で `~/.vibe-editor/team-state/<key>/<team>.json` に永続化され、
//! `register_team` の restore 経路で Hub 再起動後に復元される。一方で `TeamInfo.messages`
//! (= `team_send` 履歴 + `read_by` / `delivered_at` + `next_message_id`) は in-memory only
//! だったため、Hub 再起動でメッセージ履歴と既読状態だけが消失する非対称があった
//! (tasks は残るのに messages は消える)。本モジュールはこの message 列の永続化と復元を担う。
//!
//! # 設計判断
//! - **保存先**: orchestration state (`<team>.json`) とは別の sibling ファイル
//!   `<team>.messages.json` に保存する。同じ private dir (`0o700`) と project_key を共有しつつ、
//!   `team_state_read` IPC が返す `TeamOrchestrationState` の payload に巨大な message body を
//!   載せず、renderer dashboard の転送量を増やさない (関心の分離)。
//! - **fail-safe**: 書き込みは既存 `atomic_write`、読み込みは `safe_load_or_quarantine`
//!   (破損時は `.bak.<ts>` 退避してから default に倒す #936) をそのまま再利用する。
//! - **bounded (簡易 compaction)**: 永続化は直近 [`MAX_PERSISTED_MESSAGES`] 件だけに絞る。
//!   in-memory 上限 (`MAX_MESSAGES_PER_TEAM` = 1000) より小さくしてファイルサイズと write
//!   コストを抑え、無制限肥大を防ぐ。restore 時はこの直近 N 件が復元される。
//! - **spool 二重保存回避 (#512)**: `TeamMessage.message` は既に spool 置換後の
//!   `effective_message` (= 「summary + `[Full content saved to: <path>]`」) なので、巨大 body は
//!   `<project_root>/.vibe-team/tmp/` 側にのみ残り、message log には置換後の短い本文しか入らない。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::commands::schema_version::TEAM_STATE_SCHEMA_VERSION;
use crate::team_hub::{TeamHub, TeamInfo, TeamMessage};

/// 永続化する message 件数の上限 (簡易 compaction = 新しい順に保持)。
/// in-memory の `MAX_MESSAGES_PER_TEAM` (1000) より小さくし、保存ファイルサイズと
/// write コストを抑える。これを超える分は古い順に捨てる (= bounded、無制限肥大しない)。
pub(crate) const MAX_PERSISTED_MESSAGES: usize = 500;

/// `TeamMessage` 1 件の永続化スナップショット。`TeamMessage` 自体は `#[derive(Clone)]` のみで
/// serde を持たない (in-memory 型) ため、永続化境界で serde 可能な本 struct へ写す。
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamMessageSnapshot {
    pub id: u32,
    pub from: String,
    pub from_agent_id: String,
    pub to: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub resolved_recipient_ids: Vec<String>,
    pub message: String,
    pub timestamp: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub read_by: Vec<String>,
    // nit-3 (reviewer): read_at の永続化は best-effort。既読判定の SSOT は read_by 側であり
    // (read.rs の unread 判定参照)、read_at は表示用の補助時刻にすぎない。再起動後は次回の
    // send/read で全件 re-snapshot されるため、ここで多少欠けても整合性は read_by が担保する。
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub read_at: std::collections::HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub delivered_to: Vec<String>,
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub delivered_at: std::collections::HashMap<String, String>,
}

/// `<team>.messages.json` のファイルスキーマ。
///
/// nit-2 (reviewer): ファイル名 `<team>.messages.json` は orchestration state の
/// `<team>.json` と同じ dir に置くが衝突しない。両者は `team_state_path` 由来で末尾拡張子だけ
/// 異なり (`<safe_segment(team_id)>.json` vs `.messages.json`)、team_id は実運用で uuid 状の
/// 一意 id (`<role>-<n>-team-<uuid>` 等) のため別 team とも衝突しない。Phase 1 では subdir 化
/// などの再構成はしない (必要になれば別 Issue で扱う)。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TeamMessageLog {
    pub schema_version: u32,
    pub team_id: String,
    #[serde(default)]
    pub next_message_id: u32,
    #[serde(default)]
    pub messages: Vec<TeamMessageSnapshot>,
}

pub(crate) fn to_snapshot(m: &TeamMessage) -> TeamMessageSnapshot {
    TeamMessageSnapshot {
        id: m.id,
        from: m.from.clone(),
        from_agent_id: m.from_agent_id.clone(),
        to: m.to.clone(),
        kind: m.kind.clone(),
        resolved_recipient_ids: m.resolved_recipient_ids.clone(),
        message: m.message.clone(),
        timestamp: m.timestamp.clone(),
        read_by: m.read_by.clone(),
        read_at: m.read_at.clone(),
        delivered_to: m.delivered_to.clone(),
        delivered_at: m.delivered_at.clone(),
    }
}

pub(crate) fn from_snapshot(s: TeamMessageSnapshot) -> TeamMessage {
    TeamMessage {
        id: s.id,
        from: s.from,
        from_agent_id: s.from_agent_id,
        to: s.to,
        kind: s.kind,
        resolved_recipient_ids: s.resolved_recipient_ids,
        message: s.message,
        timestamp: s.timestamp,
        read_by: s.read_by,
        read_at: s.read_at,
        delivered_to: s.delivered_to,
        delivered_at: s.delivered_at,
    }
}

/// `TeamInfo` から永続化用ログを組み立てる (純粋関数)。直近 [`MAX_PERSISTED_MESSAGES`] 件だけを
/// snapshot 化する (= 簡易 compaction)。`next_message_id` は単調増加カウンタなのでそのまま持つ。
pub(crate) fn build_log(team_id: &str, team: &TeamInfo) -> TeamMessageLog {
    let start = team.messages.len().saturating_sub(MAX_PERSISTED_MESSAGES);
    let messages: Vec<TeamMessageSnapshot> =
        team.messages.iter().skip(start).map(to_snapshot).collect();
    TeamMessageLog {
        schema_version: TEAM_STATE_SCHEMA_VERSION,
        team_id: team_id.to_string(),
        next_message_id: team.next_message_id,
        messages,
    }
}

/// 永続化ログを `TeamInfo` へ適用する (純粋関数)。
/// - `messages` が空のときだけ復元する (= live な in-memory 履歴を clobber しない)。
/// - `next_message_id` は「現状 / 保存値 / 復元 message の最大 id」の最大に引き上げる
///   (再起動後の `team_send` が既存 id を再利用しないようにするため)。
pub(crate) fn apply_log(team: &mut TeamInfo, log: TeamMessageLog) {
    if team.messages.is_empty() {
        team.messages = log.messages.into_iter().map(from_snapshot).collect();
    }
    let max_id = team.messages.iter().map(|m| m.id).max().unwrap_or(0);
    team.next_message_id = team.next_message_id.max(log.next_message_id).max(max_id);
}

/// `<team>.json` (orchestration state) と同じディレクトリに置く `<team>.messages.json` のパス。
fn message_log_path(project_root: &str, team_id: &str) -> PathBuf {
    crate::commands::team_state::team_state_path(project_root, team_id)
        .with_extension("messages.json")
}

/// 明示パスへ message log を atomic_write する (テスト可能な I/O コア)。
pub(crate) async fn save_message_log_to_path(
    path: &Path,
    log: &TeamMessageLog,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        // 既存 orchestration state と同じ 0o700 private dir 規約を共有する。
        crate::commands::team_state::ensure_private_dir(parent).await?;
    }
    let json = serde_json::to_vec_pretty(log).map_err(|e| e.to_string())?;
    crate::commands::atomic_write::atomic_write(path, &json)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 明示パスから message log を読む (破損時は退避してから `None`)。不在も `None`。
///
/// schema_version (reviewer): 現状 `schema_version` フィールドは load 時に検証していない
/// (serde の `#[serde(default)]` 依存で、未知/将来版でも as-is に読む)。team-state 本体と同じ
/// `TEAM_STATE_SCHEMA_VERSION` を共有しており、将来 message log のスキーマを bump する際は、
/// ここ (load 直後) で `log.schema_version` を見て migration / 互換チェックを行うこと。
pub(crate) async fn load_message_log_from_path(path: &Path) -> Option<TeamMessageLog> {
    use crate::commands::safe_load::{safe_load_or_quarantine, LoadOutcome};
    match safe_load_or_quarantine::<TeamMessageLog>(path, None).await {
        LoadOutcome::Loaded(log) => Some(log),
        LoadOutcome::Absent | LoadOutcome::Corrupted => None,
    }
}

impl TeamHub {
    /// Issue #1071: 当該 team の message 列 + `next_message_id` を `<team>.messages.json` へ保存する。
    /// project_root 未設定 (= MCP setup 前 / テストの一部) のときは no-op で `Ok(())`。
    pub async fn persist_team_messages(&self, team_id: &str) -> Result<(), String> {
        let (project_root, log) = {
            let s = self.state.lock().await;
            let Some(team) = s.teams.get(team_id) else {
                return Ok(());
            };
            let Some(project_root) = team
                .project_root
                .clone()
                .filter(|p| !p.trim().is_empty())
            else {
                return Ok(());
            };
            (project_root, build_log(team_id, team))
        };
        let path = message_log_path(&project_root, team_id);
        save_message_log_to_path(&path, &log).await
    }

    /// Issue #1071: `register_team` の restore 経路から呼ぶ。`<team>.messages.json` を読み、
    /// in-memory `messages` が空なら復元し、`next_message_id` を引き上げる。
    pub async fn restore_team_messages(&self, team_id: &str) {
        let project_root = {
            let s = self.state.lock().await;
            let Some(project_root) = s
                .teams
                .get(team_id)
                .and_then(|t| t.project_root.clone())
                .filter(|p| !p.trim().is_empty())
            else {
                return;
            };
            project_root
        };
        let path = message_log_path(&project_root, team_id);
        let Some(log) = load_message_log_from_path(&path).await else {
            return;
        };
        let mut s = self.state.lock().await;
        let team = s
            .teams
            .entry(team_id.to_string())
            .or_insert_with(TeamInfo::default);
        apply_log(team, log);
    }

    /// Issue #1071/#1072: `team_send` の push 直後に呼ぶ共通 persist。
    /// Issue #1072 Part3 で write amplification を解消するため、message log は即時 atomic_write せず
    /// dirty マーク (debounce flusher が ~750ms 間隔/閾値超でまとめ書き) に変更した。
    /// leader summary feed (worker_reports) 更新時のみ orchestration state を即時 persist する。
    /// エラーは warn ログのみ (送信フロー自体は失敗させない、従来挙動を踏襲)。
    pub async fn persist_after_send(&self, team_id: &str, also_state: bool) {
        self.mark_message_dirty(team_id).await;
        if also_state {
            if let Err(e) = self.persist_team_state(team_id).await {
                tracing::warn!("[team_send] persist leader summary feed failed: {e}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn msg(id: u32, read_by: &[&str]) -> TeamMessage {
        TeamMessage {
            id,
            from: "leader".into(),
            from_agent_id: "leader-1".into(),
            to: "worker".into(),
            kind: "advisory".into(),
            resolved_recipient_ids: vec!["worker-1".into()],
            message: format!("message {id}"),
            timestamp: "2026-06-20T00:00:00Z".into(),
            read_by: read_by.iter().map(|s| s.to_string()).collect(),
            read_at: HashMap::from([(read_by.first().copied().unwrap_or("leader-1").to_string(),
                "2026-06-20T00:00:00Z".to_string())]),
            delivered_to: vec!["worker-1".into()],
            delivered_at: HashMap::from([("worker-1".to_string(), "2026-06-20T00:00:01Z".to_string())]),
        }
    }

    fn team_with(messages: Vec<TeamMessage>, next_id: u32) -> TeamInfo {
        TeamInfo {
            project_root: Some("/tmp/repo".into()),
            next_message_id: next_id,
            messages: messages.into_iter().collect(),
            ..TeamInfo::default()
        }
    }

    /// snapshot の serde roundtrip で read_by / read_at / delivered_at が保たれる。
    #[test]
    fn snapshot_serde_roundtrips_read_state() {
        let snap = to_snapshot(&msg(7, &["leader-1", "worker-1"]));
        let json = serde_json::to_vec(&snap).unwrap();
        let back: TeamMessageSnapshot = serde_json::from_slice(&json).unwrap();
        assert_eq!(snap, back);
        assert_eq!(back.read_by, vec!["leader-1", "worker-1"]);
        assert_eq!(back.delivered_at.get("worker-1").map(String::as_str), Some("2026-06-20T00:00:01Z"));
        // camelCase で serialize される (renderer / 既存 team-state 規約と整合)。
        let text = serde_json::to_string(&snap).unwrap();
        assert!(text.contains("\"fromAgentId\""));
        assert!(text.contains("\"readBy\""));
    }

    /// build_log は直近 MAX_PERSISTED_MESSAGES 件だけを保存する (bounded / 簡易 compaction)。
    #[test]
    fn build_log_is_bounded_to_newest_messages() {
        let total = MAX_PERSISTED_MESSAGES + 20;
        let messages: Vec<TeamMessage> = (1..=total as u32).map(|id| msg(id, &["leader-1"])).collect();
        let team = team_with(messages, total as u32);
        let log = build_log("team-1", &team);
        assert_eq!(log.messages.len(), MAX_PERSISTED_MESSAGES, "保存件数は上限に収まる");
        // 新しい順に残る = 最古は捨て、最新 id は保持される。
        assert_eq!(log.messages.first().unwrap().id, 21);
        assert_eq!(log.messages.last().unwrap().id, total as u32);
        assert_eq!(log.next_message_id, total as u32, "next_message_id は単調カウンタで保持");
    }

    /// spool 済み payload は本文置換後 (`[Full content saved to: ...]`) の形だけが保存され、
    /// 巨大 body は二重保存されない (#512)。
    #[test]
    fn build_log_does_not_double_store_spooled_body() {
        let mut m = msg(1, &["leader-1"]);
        // team_send は spool 化済みの effective_message を message に入れる。
        m.message = "先頭サマリ\n[Full content saved to: /repo/.vibe-team/tmp/send-abcd1234.md]".into();
        let team = team_with(vec![m], 1);
        let log = build_log("team-1", &team);
        let stored = &log.messages[0].message;
        assert!(stored.contains("[Full content saved to:"), "置換後の参照行を保持する");
        assert!(stored.len() < 200, "巨大 body ではなく短い置換本文だけが保存される");
    }

    /// apply_log は空の TeamInfo に messages と read_by を復元し、next_message_id を引き上げる
    /// (= Hub 再起動相当: 保存ログ → 新規 state へ適用)。
    #[test]
    fn apply_log_restores_messages_and_read_state() {
        let saved = build_log("team-1", &team_with(vec![msg(3, &["leader-1", "worker-1"]), msg(4, &["leader-1"])], 4));
        let mut fresh = TeamInfo::default();
        apply_log(&mut fresh, saved);
        assert_eq!(fresh.messages.len(), 2);
        let m3 = fresh.messages.iter().find(|m| m.id == 3).unwrap();
        assert!(m3.read_by.contains(&"worker-1".to_string()), "既読状態 (read_by) が復元される");
        assert_eq!(m3.delivered_at.get("worker-1").map(String::as_str), Some("2026-06-20T00:00:01Z"));
        assert_eq!(fresh.next_message_id, 4, "next_message_id が復元される");
    }

    /// apply_log は既存 in-memory messages を clobber しないが next_message_id は引き上げる。
    #[test]
    fn apply_log_does_not_clobber_existing_messages() {
        let saved = build_log("team-1", &team_with(vec![msg(1, &["leader-1"]), msg(2, &["leader-1"])], 2));
        let mut live = team_with(vec![msg(9, &["leader-1"])], 9);
        apply_log(&mut live, saved);
        assert_eq!(live.messages.len(), 1, "live な履歴は上書きされない");
        assert_eq!(live.messages[0].id, 9);
        assert_eq!(live.next_message_id, 9, "より大きい現状値を維持する");
    }

    /// 明示パスへの save → load roundtrip (= ディスク永続化の往復) で全フィールドが保たれる。
    #[tokio::test]
    async fn save_load_path_roundtrip_preserves_messages() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("team-x.messages.json");
        let log = build_log("team-x", &team_with(vec![msg(1, &["leader-1"]), msg(2, &["leader-1", "worker-1"])], 2));
        save_message_log_to_path(&path, &log).await.unwrap();

        let loaded = load_message_log_from_path(&path).await.expect("saved log loads back");
        assert_eq!(loaded.team_id, "team-x");
        assert_eq!(loaded.next_message_id, 2);
        assert_eq!(loaded.messages.len(), 2);
        let m2 = loaded.messages.iter().find(|m| m.id == 2).unwrap();
        assert_eq!(m2.read_by, vec!["leader-1", "worker-1"]);
    }

    /// 不在ファイルは None (= 復元なし)、退避ファイルも作らない。
    #[tokio::test]
    async fn load_from_missing_path_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("absent.messages.json");
        assert!(load_message_log_from_path(&path).await.is_none());
    }
}

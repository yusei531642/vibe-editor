//! Issue #930: Tauri イベント payload の名前付き struct 集約。
//!
//! 従来は emit 側ごとに `serde_json::json!` リテラルで即席組み立てされ、TS 側の受信
//! interface と二重手書きになっていたため、同一イベントでも emit 箇所間で形状が分岐し
//! (recruit-request の waitPolicy 有無)、TS 側のファントムフィールド
//! (customInstructions) やフィールド欠落 (handoff の retried) を型検査で検出できなかった。
//!
//! 本 module の struct を emit に使い、`src/types/shared.ts` の同名 interface と
//! `#[serde(rename_all = "camelCase")]` で同期する。新しいイベントを足すときも
//! `json!` リテラルではなくここに struct を定義すること。

use serde::Serialize;

/// `team:recruit-request` の payload。shared.ts の `RecruitRequestPayload` と同期。
///
/// emit 箇所:
/// - `protocol/tools/recruit.rs` (worker 採用 — waitPolicy / dynamicRole あり)
/// - `protocol/tools/create_leader.rs` (leader 生成 — waitPolicy なし / dynamicRole は None)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecruitRequestPayload {
    pub team_id: String,
    pub requester_agent_id: String,
    pub requester_role: String,
    pub new_agent_id: String,
    pub role_profile_id: String,
    pub engine: String,
    pub agent_label_hint: String,
    /// create_leader 経路では None (leader に wait_policy 概念が無い)。
    /// 従来どおり「キー自体を載せない」形を保つため skip する。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wait_policy: Option<String>,
    /// `team_recruit(role_definition=...)` の 1 ステップ採用時のみ Some。
    /// renderer は RoleProfilesContext のメモリキャッシュに追加する。
    pub dynamic_role: Option<RecruitRequestDynamicRole>,
}

/// recruit-request に同梱される動的ロール定義。shared.ts の `RecruitRequestDynamicRole` と同期。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecruitRequestDynamicRole {
    pub id: String,
    pub label: String,
    pub description: String,
    pub instructions: String,
    pub instructions_ja: Option<String>,
}

/// `team:handoff` の payload。shared.ts の `HandoffPayload` と同期。
///
/// emit 箇所:
/// - `protocol/tools/send.rs` (初回配送 — retried=false)
/// - `commands/team_inject.rs` (`app_team_retry_inject` の再送成功 — retried=true)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffEventPayload {
    pub team_id: String,
    pub from_agent_id: String,
    pub from_role: String,
    pub to_agent_id: String,
    pub to_role: String,
    pub preview: String,
    pub message_id: u32,
    pub timestamp: String,
    /// retry 経由の配送なら true。UI が「再送で届いた」ことを区別して描画できる。
    pub retried: bool,
}

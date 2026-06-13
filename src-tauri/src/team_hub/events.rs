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

use crate::commands::team_state::FileLockConflictSnapshot;
use crate::team_hub::role_lint::RoleLintFinding;
use serde::Serialize;
use ts_rs::TS;

/// `team:recruit-request` の payload。shared.ts の `RecruitRequestPayload` と同期。
///
/// emit 箇所:
/// - `protocol/tools/recruit.rs` (worker 採用 — waitPolicy / dynamicRole あり)
/// - `protocol/tools/create_leader.rs` (leader 生成 — waitPolicy なし / dynamicRole は None)
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
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
    #[ts(optional = nullable)]
    pub wait_policy: Option<String>,
    /// `team_recruit(role_definition=...)` の 1 ステップ採用時のみ Some。
    /// renderer は RoleProfilesContext のメモリキャッシュに追加する。
    pub dynamic_role: Option<RecruitRequestDynamicRole>,
}

/// recruit-request に同梱される動的ロール定義。shared.ts の `RecruitRequestDynamicRole` と同期。
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
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
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
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

/// `team:inject_failed` の payload。shared.ts の `TeamInjectFailedEvent` と同期。
///
/// emit 箇所:
/// - `protocol/tools/send.rs` (初回配送の inject 失敗 — retried フィールド無し)
/// - `commands/team_inject.rs` (`app_team_retry_inject` の再失敗 — retried=true)
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct InjectFailedEventPayload {
    pub team_id: String,
    pub from_agent_id: String,
    pub from_role: String,
    pub to_agent_id: String,
    pub to_role: String,
    pub message_id: u32,
    pub reason_code: String,
    pub reason_message: String,
    pub failed_at: String,
    /// retry IPC 経由の再失敗なら true。初回配送 (send.rs) では false。
    /// TS 側 `TeamInjectFailedEvent.retried` は optional だが、struct 化に伴い常に
    /// 明示送出する (false も載る) ことで emit 箇所間の形状を統一する。
    pub retried: bool,
}

/// `team:recruit-cancelled` の payload。shared.ts / use-recruit-listener.ts の
/// `RecruitCancelledPayload` と同期。
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct RecruitCancelledPayload {
    pub new_agent_id: String,
    pub reason: String,
}

/// `team:dismiss-request` の payload。renderer の recruit listener と同期。
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct DismissRequestPayload {
    pub team_id: String,
    pub agent_id: String,
}

/// `team:role-lint-warning` の payload。recruit / assign_task の warning toast で共有。
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct RoleLintWarningPayload {
    pub team_id: String,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub role_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub task_id: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub assignee: Option<String>,
    pub message: String,
    pub findings: Vec<RoleLintFinding>,
}

/// `team:file-lock-conflict` の payload。ToastProvider が warning toast として表示する。
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct FileLockConflictEventPayload {
    pub team_id: String,
    pub source: String,
    pub task_id: u32,
    pub assignee: String,
    pub message: String,
    pub conflicts: Vec<FileLockConflictSnapshot>,
}

/// `team:inbox_read` の payload。shared.ts の `TeamInboxReadEvent` と同期。
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct InboxReadEventPayload {
    pub team_id: String,
    pub message_ids: Vec<u32>,
    pub read_by_agent_id: String,
    pub read_by_role: String,
    pub read_at: String,
}

/// `team:role-created` の payload。RoleProfilesContext の event listener と同期。
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct RoleCreatedPayload {
    pub team_id: String,
    pub role: RoleCreatedRolePayload,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct RoleCreatedRolePayload {
    pub id: String,
    pub label: String,
    pub description: String,
    pub instructions: String,
    pub instructions_ja: Option<String>,
    pub team_id: String,
    pub created_by_role: String,
}

#[cfg(test)]
mod ts_bindings_tests {
    use super::*;
    use crate::commands::team_state::FileLockConflictSnapshot;
    use crate::team_hub::role_lint::{RoleLintFinding, RoleLintLevel};
    use std::{fs, path::PathBuf};
    use ts_rs::TS;

    const GENERATED_PATH: &str = "../src/types/generated/team-events.ts";

    fn generated_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(GENERATED_PATH)
    }

    fn declaration<T: TS>() -> String {
        format!("export {}\n", T::decl())
    }

    fn render() -> String {
        [
            "// This file is generated from src-tauri/src/team_hub/events.rs via ts-rs.",
            "// Run `npm run generate:team-event-types` after changing TeamHub event payload structs.",
            "",
            &declaration::<RoleLintLevel>(),
            &declaration::<RoleLintFinding>(),
            &declaration::<FileLockConflictSnapshot>(),
            &declaration::<RecruitCancelledPayload>(),
            &declaration::<DismissRequestPayload>(),
            &declaration::<RoleLintWarningPayload>(),
            &declaration::<FileLockConflictEventPayload>(),
            &declaration::<InboxReadEventPayload>(),
            &declaration::<RoleCreatedRolePayload>(),
            &declaration::<RoleCreatedPayload>(),
        ]
        .join("\n")
    }

    #[test]
    fn generated_team_event_bindings_are_current() {
        let path = generated_path();
        let next = render();
        if std::env::var_os("UPDATE_TEAM_EVENT_TYPES").is_some() {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("create generated type directory");
            }
            fs::write(&path, next).expect("write generated team event types");
            return;
        }

        let current = fs::read_to_string(&path).expect("read generated team event types");
        assert_eq!(
            current, next,
            "{} is stale; run `npm run generate:team-event-types`",
            path.display()
        );
    }
}

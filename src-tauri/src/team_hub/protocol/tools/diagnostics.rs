//! tool: `team_diagnostics` - per-member diagnostic timestamps and counters.

use crate::team_hub::{CallContext, MemberDiagnostics, TeamHub, TeamMessage};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::collections::HashMap;

use super::super::helpers::message_is_for_me;
use super::super::permissions::{check_permission, Permission};

const STALLED_INBOUND_THRESHOLD_MS: i64 = 60_000;

#[derive(Debug, PartialEq, Eq)]
struct PendingInboxSummary {
    ids: Vec<u32>,
    oldest_age_ms: Option<i64>,
    stalled: bool,
}

fn parse_rfc3339_utc(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

fn pending_inbox_summary(
    messages: &[TeamMessage],
    agent_id: &str,
    role: &str,
    now: DateTime<Utc>,
) -> PendingInboxSummary {
    let mut ids = Vec::new();
    let mut oldest_at: Option<DateTime<Utc>> = None;

    for message in messages {
        if message.from_agent_id == agent_id {
            continue;
        }
        if !message_is_for_me(&message.resolved_recipient_ids, &message.to, role, agent_id) {
            continue;
        }
        if message.read_by.iter().any(|id| id == agent_id) {
            continue;
        }
        if !message.delivered_to.iter().any(|id| id == agent_id) {
            continue;
        }

        ids.push(message.id);
        let delivered_at = message
            .delivered_at
            .get(agent_id)
            .and_then(|value| parse_rfc3339_utc(value))
            .or_else(|| parse_rfc3339_utc(&message.timestamp));
        if let Some(delivered_at) = delivered_at {
            oldest_at = match oldest_at {
                Some(current) if current <= delivered_at => Some(current),
                _ => Some(delivered_at),
            };
        }
    }

    let oldest_age_ms = oldest_at.map(|oldest| (now - oldest).num_milliseconds().max(0));
    let stalled = oldest_age_ms.is_some_and(|age| age >= STALLED_INBOUND_THRESHOLD_MS);

    PendingInboxSummary {
        ids,
        oldest_age_ms,
        stalled,
    }
}

fn build_member_diagnostics_row(
    agent_id: &str,
    role: &str,
    inconsistent: bool,
    diagnostics: &MemberDiagnostics,
    messages: &[TeamMessage],
    now: DateTime<Utc>,
) -> Value {
    let pending = pending_inbox_summary(messages, agent_id, role, now);
    let pending_count = pending.ids.len();
    json!({
        "agentId": agent_id,
        "role": role,
        "online": true,
        "inconsistent": inconsistent,
        "recruitedAt": diagnostics.recruited_at,
        "lastHandshakeAt": diagnostics.last_handshake_at,
        "lastSeenAt": diagnostics.last_seen_at,
        "lastAgentActivityAt": diagnostics.last_seen_at,
        "lastMessageInAt": diagnostics.last_message_in_at,
        "lastMessageOutAt": diagnostics.last_message_out_at,
        "messagesInCount": diagnostics.messages_in_count,
        "messagesOutCount": diagnostics.messages_out_count,
        "tasksClaimedCount": diagnostics.tasks_claimed_count,
        "pendingInbox": pending.ids,
        "pendingInboxCount": pending_count,
        "oldestPendingInboxAgeMs": pending.oldest_age_ms,
        "stalledInbound": pending.stalled,
        "currentStatus": diagnostics.current_status,
        "lastStatusAt": diagnostics.last_status_at,
    })
}

pub async fn team_diagnostics(hub: &TeamHub, ctx: &CallContext) -> Result<Value, String> {
    check_permission(&ctx.role, Permission::ViewDiagnostics)
        .map_err(|e| e.into_message("view diagnostics"))?;

    let bindings_snapshot: HashMap<String, String>;
    let diag_snapshot: HashMap<String, MemberDiagnostics>;
    let messages_snapshot: Vec<TeamMessage>;
    {
        let state = hub.state.lock().await;
        bindings_snapshot = state.agent_role_bindings.clone();
        diag_snapshot = state.member_diagnostics.clone();
        messages_snapshot = state
            .teams
            .get(&ctx.team_id)
            .map(|team| team.messages.iter().cloned().collect())
            .unwrap_or_default();
    }

    let now = Utc::now();
    let members: Vec<_> = hub
        .registry
        .list_team_members(&ctx.team_id)
        .into_iter()
        .map(|(aid, role)| {
            let inconsistent = match bindings_snapshot.get(&aid) {
                Some(bound) => !bound.eq_ignore_ascii_case(&role),
                None => false,
            };
            let diagnostics = diag_snapshot.get(&aid).cloned().unwrap_or_default();
            build_member_diagnostics_row(
                &aid,
                &role,
                inconsistent,
                &diagnostics,
                &messages_snapshot,
                now,
            )
        })
        .collect();

    Ok(json!({
        "myAgentId": ctx.agent_id,
        "myRole": ctx.role,
        "teamId": ctx.team_id,
        "serverLogPath": crate::team_hub::server_log_path_for_diagnostics(),
        "members": members,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};

    fn delivered_unread_message() -> TeamMessage {
        TeamMessage {
            id: 7,
            from: "leader".into(),
            from_agent_id: "leader-1".into(),
            to: "worker".into(),
            resolved_recipient_ids: vec!["worker-1".into()],
            message: "please continue".into(),
            timestamp: "2026-05-04T10:00:00Z".into(),
            read_by: vec!["leader-1".into()],
            read_at: HashMap::from([("leader-1".to_string(), "2026-05-04T10:00:00Z".to_string())]),
            delivered_to: vec!["worker-1".into()],
            delivered_at: HashMap::from([(
                "worker-1".to_string(),
                "2026-05-04T10:00:00Z".to_string(),
            )]),
        }
    }

    #[test]
    fn pending_summary_marks_delivered_unread_message_as_stalled() {
        let messages = vec![delivered_unread_message()];
        let now = Utc.with_ymd_and_hms(2026, 5, 4, 10, 2, 0).unwrap();

        let pending = pending_inbox_summary(&messages, "worker-1", "worker", now);

        assert_eq!(pending.ids, vec![7]);
        assert_eq!(pending.oldest_age_ms, Some(120_000));
        assert!(pending.stalled);
    }

    #[test]
    fn member_row_keeps_delivery_separate_from_agent_activity() {
        let messages = vec![delivered_unread_message()];
        let now = Utc.with_ymd_and_hms(2026, 5, 4, 10, 2, 0).unwrap();
        let diagnostics = MemberDiagnostics {
            recruited_at: "2026-05-04T09:50:00Z".into(),
            last_seen_at: Some("2026-05-04T09:55:00Z".into()),
            last_message_in_at: Some("2026-05-04T10:00:00Z".into()),
            messages_in_count: 1,
            ..MemberDiagnostics::default()
        };

        let row =
            build_member_diagnostics_row("worker-1", "worker", false, &diagnostics, &messages, now);

        assert_eq!(row["lastSeenAt"].as_str(), Some("2026-05-04T09:55:00Z"));
        assert_eq!(
            row["lastAgentActivityAt"].as_str(),
            Some("2026-05-04T09:55:00Z")
        );
        assert_eq!(
            row["lastMessageInAt"].as_str(),
            Some("2026-05-04T10:00:00Z")
        );
        assert_eq!(row["pendingInbox"].as_array().unwrap()[0].as_u64(), Some(7));
        assert_eq!(row["pendingInboxCount"].as_u64(), Some(1));
        assert_eq!(row["oldestPendingInboxAgeMs"].as_i64(), Some(120_000));
        assert_eq!(row["stalledInbound"].as_bool(), Some(true));
    }
}

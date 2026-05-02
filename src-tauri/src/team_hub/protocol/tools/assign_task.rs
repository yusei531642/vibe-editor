//! tool: `team_assign_task` — assign a task to a role/member and notify.
//!
//! Issue #373 Phase 2 で `protocol.rs` から切り出し。

use crate::team_hub::error::AssignError;
use crate::team_hub::{CallContext, TeamHub, TeamTask};
use chrono::Utc;
use serde_json::{json, Value};

use super::super::consts::{MAX_TASKS_PER_TEAM, SOFT_PAYLOAD_LIMIT};
use super::super::helpers::resolve_targets;
use super::super::permissions::caller_has_permission;
use super::send::team_send;

pub async fn team_assign_task(
    hub: &TeamHub,
    ctx: &CallContext,
    args: &Value,
) -> Result<Value, String> {
    // Issue #114: 旧実装は assignee / description の空チェックだけで権限を見ておらず、
    // canAssignTasks=false のロールでも task を作成できてしまっていた。先頭で必ず権限検証する。
    if !caller_has_permission(hub, &ctx.role, "canAssignTasks").await {
        return Err(AssignError {
            code: "assign_permission_denied".into(),
            message: format!("permission denied: role '{}' cannot assign tasks", ctx.role),
            phase: None,
            elapsed_ms: None,
        }
        .into_err_string());
    }
    let assignee_raw = args.get("assignee").and_then(|v| v.as_str()).unwrap_or("");
    let assignee = assignee_raw.trim();
    let description = args.get("description").and_then(|v| v.as_str()).unwrap_or("");
    if assignee.is_empty() || description.is_empty() {
        return Err(AssignError {
            code: "assign_invalid_args".into(),
            message: "assignee and description are required".into(),
            phase: None,
            elapsed_ms: None,
        }
        .into_err_string());
    }
    // 旧実装は assignee を一切検証せずに task を作成していた。
    // Claude (LLM) が "Programmer" / "プログラマー" / 存在しない role 名を渡すと、
    // task は作成されるが team_send 通知はゼロ宛先で no-op になり、
    // Leader からは「task は登録されたのに何も起こらない」サイレント失敗になる。
    // → 作成前に resolve_targets で検証し、無効ならエラーで弾いて roles を案内する。
    let members = hub.registry.list_team_members(&ctx.team_id);
    let active_leader_agent_id = {
        let state = hub.state.lock().await;
        state
            .teams
            .get(&ctx.team_id)
            .and_then(|team| team.active_leader_agent_id.clone())
    };
    let resolved = resolve_targets(
        &members,
        &ctx.agent_id,
        assignee,
        active_leader_agent_id.as_deref(),
    );
    if resolved.is_empty() {
        // 同 role 複数名がいる場合の重複ヒント表示を避けるため一意化する
        let mut other_roles: Vec<String> = members
            .iter()
            .filter(|(aid, _)| aid != &ctx.agent_id)
            .map(|(_, r)| r.clone())
            .filter(|r| !r.is_empty())
            .collect();
        other_roles.sort();
        other_roles.dedup();
        return Err(AssignError {
            code: "assign_unknown_assignee".into(),
            message: format!(
                "assignee '{assignee}' does not match any current team member. \
                 Valid roles: {other_roles:?} (or 'all', or an agentId)"
            ),
            phase: None,
            elapsed_ms: None,
        }
        .into_err_string());
    }
    // 「長文ペイロード・ルール」: description も SOFT_PAYLOAD_LIMIT で弾いてファイル経由を強制。
    // bulk な指示 (21 連続 issue 起票の YAML 等) はここで必ず途中切れしないために。
    // Issue #409: 通知本文には Standard response protocol hint (~700 bytes) を後から append するため、
    // 1 KiB の安全マージンを引いてから判定し、合算後に SOFT_PAYLOAD_LIMIT (= team_send 側の上限) を
    // 超えるリスクを避ける。
    const PROTOCOL_HINT_RESERVE: usize = 1024;
    let description_limit = SOFT_PAYLOAD_LIMIT.saturating_sub(PROTOCOL_HINT_RESERVE);
    if description.len() > description_limit {
        return Err(AssignError {
            code: "assign_payload_threshold".into(),
            message: format!(
                "description exceeds the long-payload threshold ({} > {} bytes). \
                 Write the full task brief to `.vibe-team/tmp/<short_id>.md` with the Write tool first, \
                 then call team_assign_task again with a brief summary plus the file path \
                 (e.g. \"21 件起票。詳細は .vibe-team/tmp/issue_bulk.md を参照\"). \
                 (Inline descriptions up to 32 KiB are now delivered via bracketed paste, but anything \
                 beyond that should still be passed by file path.)",
                description.len(),
                description_limit
            ),
            phase: None,
            elapsed_ms: None,
        }
        .into_err_string());
    }
    let task_id;
    let assigned_at = Utc::now().to_rfc3339();
    {
        let mut state = hub.state.lock().await;
        let team = state
            .teams
            .entry(ctx.team_id.clone())
            .or_insert_with(crate::team_hub::TeamInfo::default);
        // Issue #116: tasks.len()+1 だと履歴上限到達後に id が固定して衝突する。
        // 単調増加カウンタで一意性を保つ。
        team.next_task_id = team.next_task_id.saturating_add(1);
        task_id = team.next_task_id;
        team.tasks.push_back(TeamTask {
            id: task_id,
            assigned_to: assignee.to_string(),
            description: description.to_string(),
            status: "pending".into(),
            created_by: ctx.role.clone(),
            created_at: assigned_at.clone(),
        });
        // Issue #107 / #216: tasks も件数上限で古い順に O(1) で破棄
        while team.tasks.len() > MAX_TASKS_PER_TEAM {
            let _ = team.tasks.pop_front();
        }
        // Issue #342 Phase 3 (3.3): 割り振られた agent 側の tasks_claimed_count を +1 する。
        // assignee = "all" なら resolve した全員、role 名なら同 role の複数メンバー全員、
        // agent_id 指定なら 1 名。team_assign_task は「Leader が task を渡した時点」の意味で
        // claim カウンタを増やすので、後続で worker が status を変えるか否かに依存しない。
        for (target_aid, _) in &resolved {
            let diag = state
                .member_diagnostics
                .entry(target_aid.clone())
                .or_default();
            diag.tasks_claimed_count = diag.tasks_claimed_count.saturating_add(1);
        }
    }
    // Issue #172: 通知の team_send を await せず fire-and-forget でバックグラウンド spawn する。
    // assignee="all" のとき fan-out で sleep 累積して MCP RPC を秒単位でブロックしていたのを解消。
    // 配信失敗のときも呼び出し側 (Leader) には task 作成結果だけを即返す。
    //
    // Issue #409: タスク本文の末尾に「最低限の応答プロトコル」を必ず付与する。
    // Leader が個別タスク説明に書き忘れても、ワーカーが
    //   1) 開始 ACK を team_send で返す
    //   2) team_update_task(task_id, "in_progress") に変える
    //   3) 長時間タスクでは team_status で進捗を残す
    //   4) 完了時に team_send + team_update_task("done" or "blocked") を呼ぶ
    // ことで、Leader が `team_read` 0 件だけで「無応答」と誤判定するのを防ぐ。
    let notify_message = build_task_notification(task_id, description);
    let notify_args = json!({ "to": assignee, "message": notify_message });
    let hub_clone = hub.clone();
    let ctx_clone = ctx.clone();
    let task_id_for_log = task_id;
    let assignee_for_log = assignee.to_string();
    tokio::spawn(async move {
        match team_send(&hub_clone, &ctx_clone, &notify_args).await {
            Ok(v) => {
                let delivered = v
                    .get("delivered")
                    .and_then(|d| d.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0);
                if delivered == 0 {
                    // assignee 検証で resolve_targets はパスしたはずなので、ここに来るのは
                    // 「resolve した直後にメンバーが落ちた」「inject 自体が PTY write 失敗で 0 件」
                    // のいずれか。診断のため warn で落とす。
                    tracing::warn!(
                        "[team_assign_task] task #{task_id_for_log} created for '{assignee_for_log}' but inject delivered to 0 members"
                    );
                }
            }
            Err(e) => {
                tracing::warn!(
                    "[team_assign_task] task #{task_id_for_log} notify failed: {e}"
                );
            }
        }
    });
    Ok(json!({
        "success": true,
        "taskId": task_id,
        "assignedAt": assigned_at,
    }))
}

/// Issue #409: タスク通知本文に「最低限の応答プロトコル」を必ず付与する。
/// Leader が個別タスク説明にプロトコル指示を書き忘れても、ワーカーが
///   1) 開始 ACK を team_send で返す
///   2) team_update_task(task_id, "in_progress") に変える
///   3) 長時間タスクでは team_status で進捗を残す
///   4) 完了時に team_send + team_update_task("done"/"blocked") を呼ぶ
/// ことで、Leader が `team_read` 0 件だけで「無応答」と誤判定するのを防ぐ。
pub(super) fn build_task_notification(task_id: u32, description: &str) -> String {
    format!(
        "[Task #{task_id}] {description}\n\n\
         [Standard response protocol — follow even if not repeated in the task body]\n\
         1. Reply immediately with `team_send(\"leader\", \"ACK: Task #{task_id} received, starting...\")`.\n\
         2. Call `team_update_task({task_id}, \"in_progress\")`.\n\
         3. For long-running steps, call `team_status(\"...short progress line...\")` every meaningful step \
         so the Leader can see you are alive via team_diagnostics.\n\
         4. When done, send a `team_send(\"leader\", \"完了報告: ...\")` and call \
         `team_update_task({task_id}, \"done\")` (or `\"blocked\"` if you cannot finish)."
    )
}

#[cfg(test)]
mod tests {
    use super::build_task_notification;

    /// Issue #409: 通知 payload に ACK / in_progress / status / 完了プロトコルが含まれること。
    #[test]
    fn notification_embeds_standard_response_protocol() {
        let msg = build_task_notification(42u32, "リポジトリ clone & 調査");
        // 元の description が落ちていない
        assert!(msg.starts_with("[Task #42] リポジトリ clone & 調査"));
        // プロトコル節 4 項目が含まれる
        assert!(msg.contains("Standard response protocol"));
        assert!(msg.contains("ACK: Task #42 received"));
        assert!(msg.contains("team_update_task(42, \"in_progress\")"));
        assert!(msg.contains("team_status("));
        assert!(msg.contains("team_update_task(42, \"done\")"));
        assert!(msg.contains("\"blocked\""));
    }
}

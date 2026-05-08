//! tool: `team_assign_task` — assign a task to a role/member and notify.
//!
//! Issue #373 Phase 2 で `protocol.rs` から切り出し。

use crate::commands::team_state::{FileLockConflictSnapshot, TaskPreApprovalSnapshot};
use crate::team_hub::file_locks::{normalize_path, LockConflict};
use crate::team_hub::{CallContext, TeamHub, TeamTask};
use chrono::Utc;
use serde_json::{json, Value};
use tauri::Emitter;

use super::super::consts::{MAX_TASKS_PER_TEAM, SOFT_PAYLOAD_LIMIT};
use super::super::helpers::resolve_targets;
use super::super::permissions::{check_permission, Permission};
use super::error::AssignError;
use super::send::team_send;
use crate::team_hub::role_lint::{compute_task_overlap, MemberSnapshot};

fn parse_target_paths(args: &Value) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(arr) = args.get("target_paths").and_then(|v| v.as_array()) {
        for v in arr {
            let Some(raw) = v.as_str() else {
                continue;
            };
            let normalized = normalize_path(raw);
            if !normalized.is_empty() && !out.contains(&normalized) {
                out.push(normalized);
            }
        }
    }
    out
}

fn optional_text_field(
    obj: &serde_json::Map<String, Value>,
    snake: &str,
    camel: &str,
) -> Option<String> {
    obj.get(snake)
        .or_else(|| obj.get(camel))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToOwned::to_owned)
}

fn assign_invalid_pre_approval(message: impl Into<String>) -> String {
    AssignError {
        code: "assign_invalid_pre_approval".into(),
        message: message.into(),
        phase: None,
        elapsed_ms: None,
    }
    .into_err_string()
}

fn parse_pre_approval(args: &Value) -> Result<Option<TaskPreApprovalSnapshot>, String> {
    let Some(raw) = args.get("pre_approval").or_else(|| args.get("preApproval")) else {
        return Ok(None);
    };
    if raw.is_null() {
        return Ok(None);
    }
    let obj = raw.as_object().ok_or_else(|| {
        assign_invalid_pre_approval("pre_approval must be an object with allowed_actions")
    })?;
    let actions = obj
        .get("allowed_actions")
        .or_else(|| obj.get("allowedActions"))
        .and_then(|v| v.as_array())
        .ok_or_else(|| {
            assign_invalid_pre_approval(
                "pre_approval.allowed_actions must be a non-empty string array",
            )
        })?;
    let mut allowed_actions = Vec::new();
    for action in actions {
        let Some(raw) = action.as_str() else {
            return Err(assign_invalid_pre_approval(
                "pre_approval.allowed_actions must contain only strings",
            ));
        };
        let trimmed = raw.trim();
        if !trimmed.is_empty() && !allowed_actions.iter().any(|a| a == trimmed) {
            allowed_actions.push(trimmed.to_string());
        }
    }
    if allowed_actions.is_empty() {
        return Err(assign_invalid_pre_approval(
            "pre_approval.allowed_actions must contain at least one non-empty action",
        ));
    }
    Ok(Some(TaskPreApprovalSnapshot {
        allowed_actions,
        note: optional_text_field(obj, "note", "note"),
    }))
}

fn to_lock_conflict_snapshots(conflicts: &[LockConflict]) -> Vec<FileLockConflictSnapshot> {
    conflicts
        .iter()
        .map(|c| FileLockConflictSnapshot {
            path: c.path.clone(),
            holder_agent_id: c.holder_agent_id.clone(),
            holder_role: c.holder_role.clone(),
            acquired_at: c.acquired_at.clone(),
        })
        .collect()
}

fn file_lock_warning_message(
    target_paths_missing: bool,
    lock_conflicts: &[FileLockConflictSnapshot],
) -> Option<String> {
    if target_paths_missing {
        return Some(
            "team_assign_task was called without target_paths; file ownership is not tracked and \
             file-lock conflict detection was skipped"
                .to_string(),
        );
    }
    if lock_conflicts.is_empty() {
        return None;
    }
    let summary = lock_conflicts
        .iter()
        .map(|c| {
            format!(
                "{} held by {} ({})",
                c.path, c.holder_agent_id, c.holder_role
            )
        })
        .collect::<Vec<_>>()
        .join("; ");
    Some(format!("file lock conflicts detected: {summary}"))
}

pub async fn team_assign_task(
    hub: &TeamHub,
    ctx: &CallContext,
    args: &Value,
) -> Result<Value, String> {
    // Issue #114: 旧実装は assignee / description の空チェックだけで権限を見ておらず、
    // canAssignTasks=false のロールでも task を作成できてしまっていた。先頭で必ず権限検証する。
    if let Err(e) = check_permission(&ctx.role, Permission::AssignTasks) {
        return Err(
            AssignError::permission_denied("assign", &e.role, "assign tasks").into_err_string(),
        );
    }
    let assignee_raw = args.get("assignee").and_then(|v| v.as_str()).unwrap_or("");
    let assignee = assignee_raw.trim();
    let description = args
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if assignee.is_empty() || description.is_empty() {
        return Err(AssignError {
            code: "assign_invalid_args".into(),
            message: "assignee and description are required".into(),
            phase: None,
            elapsed_ms: None,
        }
        .into_err_string());
    }
    // Issue #526: `target_paths: string[]` (任意) — このタスクで触る予定のファイル / dir 宣言。
    // Hub は assign_task 時点で同 path を別 agent が握っていないか peek し、
    // `lockConflicts` を response に乗せる (advisory: 拒否はしない、Leader が判断)。
    let target_paths = parse_target_paths(args);
    let pre_approval = parse_pre_approval(args)?;
    let target_paths_missing = target_paths.is_empty();
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
    // Issue #525: #526 の advisory lock を task state へ接続する。
    // target_paths がある時点で既存 lock と peek し、response だけでなく TeamTaskSnapshot にも
    // 残す。assign 自体は引き続き advisory として成功させ、Leader が調整できる情報を返す。
    let lock_conflicts = if !target_paths.is_empty() {
        // assignee 自身が握る path は当然衝突ではないので filter で除外。
        let assignee_aid_filter = if resolved.len() == 1 {
            Some(resolved[0].0.as_str())
        } else {
            // 複数名宛て (同 role 複数 / "all") の場合は誰の lock かを単純に決められないので
            // フィルタ無し (= 全 holder を返す。Leader が boundaryWarnings 同様に解釈)。
            None
        };
        hub.peek_file_locks(&ctx.team_id, assignee_aid_filter, &target_paths)
            .await
    } else {
        Vec::new()
    };
    let lock_conflict_snapshots = to_lock_conflict_snapshots(&lock_conflicts);
    let file_lock_warning_message =
        file_lock_warning_message(target_paths_missing, &lock_conflict_snapshots);
    // Issue #512: description が SOFT_PAYLOAD_LIMIT 相当 (= protocol hint reserve 引いた値) を
    // 超過したら、Hub 側で auto-spool 化する。worker への inject 通知本文 (`team_send` 経由) は
    // 「summary + attached: <path>」の短文に置換し、TeamTask.description には **元 description**
    // を保持して `team_get_tasks` で Leader が full content を確認できるようにする。
    // boundary lint (`compute_task_overlap`) も full content で判定したいので **元 description** を渡す。
    //
    // Issue #409: 通知本文には Standard response protocol hint (~700 bytes) を後から append するため、
    // 1 KiB の安全マージンを引いてから判定し、合算後に SOFT_PAYLOAD_LIMIT (= team_send 側の上限) を
    // 超えるリスクを避ける。spool 化の reject は project_root 不在 / write 失敗時のみ発火する
    // fallback で、code 名は旧名 `assign_payload_threshold` を維持して後方互換を保つ
    // (message 文で「auto-spool 失敗」の詳細を伝える)。
    const PROTOCOL_HINT_RESERVE: usize = 1024;
    let description_limit = SOFT_PAYLOAD_LIMIT.saturating_sub(PROTOCOL_HINT_RESERVE);
    let mut spooled_description: Option<String> = None;
    if description.len() > description_limit {
        let project_root = {
            let s = hub.state.lock().await;
            s.teams
                .get(&ctx.team_id)
                .and_then(|t| t.project_root.clone())
        };
        let project_root = match project_root
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
        {
            Some(p) => p.to_string(),
            None => {
                return Err(AssignError {
                    // Issue #512 ↔ #545 review: error code は旧名 `assign_payload_threshold`
                    // を維持して後方互換を保つ (= caller が code 判定で fallback handler を
                    // 持っていても壊れない)。新挙動は「成功時に reject せず spool 化する」path
                    // のみで、reject 時の意味は旧来の SOFT_PAYLOAD_LIMIT 超過と等価。
                    code: "assign_payload_threshold".into(),
                    message: format!(
                        "description exceeds the long-payload threshold ({} > {} bytes) and \
                         this team has no project_root configured for auto-spool. \
                         Setup the team via Canvas (setupTeamMcp) or write the brief to a file \
                         and call team_assign_task again with a short summary plus the path.",
                        description.len(),
                        description_limit
                    ),
                    phase: None,
                    elapsed_ms: None,
                }
                .into_err_string());
            }
        };
        match crate::team_hub::spool::spool_long_payload(&project_root, description, "assign").await
        {
            Ok(result) => {
                tracing::info!(
                    "[team_assign_task] auto-spooled long description ({} bytes) team={} assignee={} → {}",
                    description.len(),
                    ctx.team_id,
                    assignee,
                    result.spool_path.display()
                );
                spooled_description = Some(result.replacement_message);
            }
            Err(e) => {
                tracing::warn!(
                    "[team_assign_task] auto-spool failed for team={}: {e:#}; falling back to reject",
                    ctx.team_id
                );
                return Err(AssignError {
                    // Issue #512 ↔ #545 review: error code は旧名 `assign_payload_threshold`
                    // を維持して後方互換を保つ (= caller が code 判定で fallback handler を
                    // 持っていても壊れない)。新挙動は「成功時に reject せず spool 化する」path
                    // のみで、reject 時の意味は旧来の SOFT_PAYLOAD_LIMIT 超過と等価。
                    code: "assign_payload_threshold".into(),
                    message: format!(
                        "description exceeds the long-payload threshold ({} > {} bytes) and \
                         auto-spool to `.vibe-team/tmp/` failed: {e}. \
                         Write the brief to a file with the Write tool and call team_assign_task \
                         again with a brief summary plus the file path.",
                        description.len(),
                        description_limit
                    ),
                    phase: None,
                    elapsed_ms: None,
                }
                .into_err_string());
            }
        }
    }
    // Worker への inject 通知に流す本文: spool 化された場合は summary + path、そうでなければ元 description。
    // `compute_task_overlap` (lint) と TeamTask.description (= 履歴保存) は **元 description** をそのまま使う
    // ことで、boundary 判定の精度と Leader の `team_get_tasks` review 体験を保つ。
    let notify_description: &str = spooled_description.as_deref().unwrap_or(description);
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
            updated_at: None,
            summary: None,
            blocked_reason: None,
            next_action: None,
            artifact_path: None,
            blocked_by_human_gate: false,
            required_human_decision: None,
            target_paths: target_paths.clone(),
            lock_conflicts: lock_conflict_snapshots.clone(),
            pre_approval: pre_approval.clone(),
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
    if let Err(e) = hub.persist_team_state(&ctx.team_id).await {
        tracing::warn!("[team_assign_task] persist team-state failed: {e}");
    }

    // Issue #517: 宛先 worker と他 worker の責務範囲が同領域に重なっていれば warn する。
    // 拒否はせず assign は通す (偽陽性での操作妨害を避ける)。
    // 同 role 複数名 / "all" / agentId 指定の場合は最初に解決された role_id を target として
    // 評価する (代表値で十分。複数 role が混じる場合のみ後で拡張)。
    let target_role_id = resolved
        .first()
        .map(|(_, role)| role.clone())
        .unwrap_or_default();
    let boundary_report = if !target_role_id.is_empty() {
        let members: Vec<MemberSnapshot> = hub
            .get_dynamic_roles(&ctx.team_id)
            .await
            .into_iter()
            .map(|r| MemberSnapshot {
                role_id: r.id,
                instructions: r.instructions,
                description: r.description,
            })
            .collect();
        compute_task_overlap(description, &target_role_id, &members)
    } else {
        Default::default()
    };
    if !boundary_report.is_empty() {
        // renderer 側 toast 通知用に event emit
        let app = hub.app_handle.lock().await.clone();
        if let Some(app) = &app {
            let summary = boundary_report
                .warn_message(&format!("タスク #{} の責務境界 warning", task_id))
                .unwrap_or_default();
            let payload = json!({
                "teamId": ctx.team_id,
                "source": "assign",
                "taskId": task_id,
                "assignee": assignee,
                "message": summary,
                "findings": boundary_report.findings,
            });
            if let Err(e) = app.emit("team:role-lint-warning", payload) {
                tracing::warn!("emit team:role-lint-warning (assign) failed: {e}");
            }
        }
    }
    let boundary_warning_strs = boundary_report.finding_strings();
    let boundary_warning_message =
        boundary_report.warn_message("task boundary warnings (continuing assign)");

    if !lock_conflict_snapshots.is_empty() {
        let app = hub.app_handle.lock().await.clone();
        if let Some(app) = &app {
            let summary = lock_conflict_snapshots
                .iter()
                .map(|c| {
                    format!(
                        "{} held by {} ({})",
                        c.path, c.holder_agent_id, c.holder_role
                    )
                })
                .collect::<Vec<_>>()
                .join("; ");
            let payload = json!({
                "teamId": ctx.team_id,
                "source": "assign",
                "taskId": task_id,
                "assignee": assignee,
                "message": format!("タスク #{} の file lock 競合: {}", task_id, summary),
                "conflicts": lock_conflict_snapshots.clone(),
            });
            if let Err(e) = app.emit("team:file-lock-conflict", payload) {
                tracing::warn!("emit team:file-lock-conflict failed: {e}");
            }
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
    let notify_message = build_task_notification(
        task_id,
        notify_description,
        &target_paths,
        pre_approval.as_ref(),
    );
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
                tracing::warn!("[team_assign_task] task #{task_id_for_log} notify failed: {e}");
            }
        }
    });
    Ok(json!({
        "success": true,
        "taskId": task_id,
        "assignedAt": assigned_at,
        "boundaryWarnings": boundary_warning_strs,
        "boundaryWarningMessage": boundary_warning_message,
        "targetPaths": target_paths,
        "targetPathsMissing": target_paths_missing,
        "fileLockWarningMessage": file_lock_warning_message,
        "lockConflicts": lock_conflict_snapshots,
        "preApproval": pre_approval,
    }))
}

/// Issue #409: タスク通知本文に「最低限の応答プロトコル」を必ず付与する。
/// Leader が個別タスク説明にプロトコル指示を書き忘れても、ワーカーが
///   1) 開始 ACK を team_send で返す
///   2) team_update_task(task_id, "in_progress") に変える
///   3) 長時間タスクでは team_status で進捗を残す
///   4) 完了時に team_send + team_update_task("done"/"blocked") を呼ぶ
///
/// ことで、Leader が `team_read` 0 件だけで「無応答」と誤判定するのを防ぐ。
pub(super) fn build_task_notification(
    task_id: u32,
    description: &str,
    target_paths: &[String],
    pre_approval: Option<&TaskPreApprovalSnapshot>,
) -> String {
    let file_lock_section = if target_paths.is_empty() {
        String::new()
    } else {
        let target_paths_json =
            serde_json::to_string(target_paths).unwrap_or_else(|_| "[]".to_string());
        let target_paths_list = target_paths
            .iter()
            .map(|path| format!("         - {path}"))
            .collect::<Vec<_>>()
            .join("\n");
        format!(
            "\n\n\
             [File ownership protocol — follow before editing]\n\
             Target paths declared by the Leader:\n{target_paths_list}\n\
             Before using Edit / Write / MultiEdit on these paths, call \
             `team_lock_files({{\"paths\":{target_paths_json}}})`. If `conflicts` is non-empty, \
             stop editing and report the conflict with `team_send(\"leader\", \"file lock conflict: ...\")`. \
             After finishing or failing, call `team_unlock_files({{\"paths\":{target_paths_json}}})`."
        )
    };
    let pre_approval_section = pre_approval
        .map(|approval| {
            let actions = approval
                .allowed_actions
                .iter()
                .map(|action| format!("         - {action}"))
                .collect::<Vec<_>>()
                .join("\n");
            let note = approval
                .note
                .as_deref()
                .map(|n| format!("\n             Note: {n}"))
                .unwrap_or_default();
            format!(
                "\n\n\
                 [Pre-approval — limited autonomy]\n\
                 You may perform only these lightweight actions without asking the Leader first:\n{actions}{note}\n\
                 Anything outside this list requires a `team_send({{\"to\":\"leader\",\"kind\":\"request\",\"message\":\"...\"}})` \
                 proposal before execution."
            )
        })
        .unwrap_or_default();
    format!(
        "[Task #{task_id}] {description}{file_lock_section}{pre_approval_section}\n\n\
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
    use super::{build_task_notification, parse_pre_approval, parse_target_paths};
    use crate::commands::team_state::TaskPreApprovalSnapshot;
    use serde_json::json;

    /// Issue #409: 通知 payload に ACK / in_progress / status / 完了プロトコルが含まれること。
    #[test]
    fn notification_embeds_standard_response_protocol() {
        let msg = build_task_notification(42u32, "リポジトリ clone & 調査", &[], None);
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

    /// Issue #525: target_paths がある task 通知には、worker が編集前に file lock を取る
    /// ための具体的な path と tool 呼び出しが含まれること。
    #[test]
    fn notification_embeds_file_lock_protocol_when_target_paths_are_declared() {
        let paths = vec![
            "src/renderer/src/lib/role-profiles-builtin.ts".to_string(),
            "src-tauri/src/team_hub/protocol/tools/assign_task.rs".to_string(),
        ];
        let msg = build_task_notification(525u32, "file ownership を補強する", &paths, None);
        assert!(msg.contains("File ownership protocol"));
        assert!(msg.contains("team_lock_files"));
        assert!(msg.contains("team_unlock_files"));
        assert!(msg.contains("file lock conflict"));
        assert!(msg.contains("src/renderer/src/lib/role-profiles-builtin.ts"));
        assert!(msg.contains("src-tauri/src/team_hub/protocol/tools/assign_task.rs"));
    }

    /// Issue #525: Leader が渡した target_paths は Hub の path 正規化と同じ規則で
    /// 保存用に整える。空 path / 重複 / Windows separator が残ると ownership 表示が揺れる。
    #[test]
    fn parse_target_paths_normalizes_dedups_and_skips_empty_paths() {
        let paths = parse_target_paths(&json!({
            "target_paths": [
                "src\\foo.rs",
                "./src/foo.rs",
                "",
                "src//bar.rs/",
                42
            ]
        }));
        assert_eq!(paths, vec!["src/foo.rs", "src/bar.rs"]);
    }

    #[test]
    fn parse_pre_approval_accepts_camel_and_dedups_actions() {
        let pre_approval = parse_pre_approval(&json!({
            "preApproval": {
                "allowedActions": ["read docs", "read docs", "run focused test"],
                "note": "no edits"
            }
        }))
        .unwrap()
        .expect("pre approval");

        assert_eq!(
            pre_approval.allowed_actions,
            vec!["read docs", "run focused test"]
        );
        assert_eq!(pre_approval.note.as_deref(), Some("no edits"));
    }

    #[test]
    fn parse_pre_approval_rejects_empty_actions() {
        let err = parse_pre_approval(&json!({
            "pre_approval": { "allowed_actions": [" ", ""] }
        }))
        .unwrap_err();

        assert!(err.contains("assign_invalid_pre_approval"));
        assert!(err.contains("at least one non-empty action"));
    }

    #[test]
    fn notification_embeds_pre_approval_protocol() {
        let approval = TaskPreApprovalSnapshot {
            allowed_actions: vec!["read docs".into(), "run focused test".into()],
            note: Some("no file edits".into()),
        };
        let msg = build_task_notification(523u32, "軽量調査", &[], Some(&approval));

        assert!(msg.contains("Pre-approval"));
        assert!(msg.contains("read docs"));
        assert!(msg.contains("run focused test"));
        assert!(msg.contains("no file edits"));
        assert!(msg.contains("\"kind\":\"request\""));
    }
}

//! tool: `team_create_leader` — Issue #423: 現 Leader が引き継ぎのために
//! 「同チームの新 Leader」を 1 人だけ追加で採用する MCP tool。
//!
//! `team_recruit` を leader role 専用 + singleton bypass で薄くラップしたもの。
//! 通常の `team_recruit(role_id="leader")` は singleton 制約に引っかかるため、
//! 引き継ぎ過渡状態 (旧+新 leader が一時的に並ぶ) を作るには専用経路が必要。
//!
//! 旧 leader はこの tool で新 leader を作ったあと `team_switch_leader` で
//! active leader を切り替え、自身のカードを retire する流れを想定する。

use crate::team_hub::error::RecruitError;
use crate::team_hub::{CallContext, TeamHub};
use serde_json::{json, Value};
use std::time::Instant;
use tauri::Emitter;
use uuid::Uuid;

use super::super::consts::{RECRUIT_ACK_TIMEOUT, RECRUIT_TIMEOUT};
use super::super::permissions::caller_has_permission;

/// `team_create_leader` — 引き継ぎ用に同 teamId へ追加の leader カードを spawn する。
///
/// 通常の `team_recruit` と異なる点:
///   - `role_id` は "leader" 固定 (引数で受け取らない)
///   - leader は本来 singleton role だが、ここでは singleton 制約をバイパスする
///     (旧 leader と並走させるのが目的なので)
///   - 動的ロール定義の同梱は受け付けない (leader は builtin)
///
/// 引数:
///   - `engine` (任意): claude / codex。省略時は claude。
///   - `agent_label_hint` (任意): canvas カードのタイトル上書き。
pub async fn team_create_leader(
    hub: &TeamHub,
    ctx: &CallContext,
    args: &Value,
) -> Result<Value, String> {
    if !caller_has_permission(hub, &ctx.role, "canRecruit").await {
        return Err(RecruitError {
            code: "create_leader_permission_denied".into(),
            message: format!(
                "permission denied: role '{}' cannot create leader",
                ctx.role
            ),
            phase: None,
            elapsed_ms: None,
        }
        .into_err_string());
    }

    let role_profile_id = "leader".to_string();

    let engine = args
        .get("engine")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let agent_label_hint = args
        .get("agent_label_hint")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let handoff_id = args
        .get("handoff_id")
        .or_else(|| args.get("handoffId"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToOwned::to_owned);

    // builtin の leader profile から default engine を引く
    let summary = hub.get_role_profile_summary().await;
    let target = summary.iter().find(|p| p.id == role_profile_id);
    let resolved_engine = if engine.is_empty() {
        target
            .map(|t| t.default_engine.clone())
            .unwrap_or_else(|| "claude".to_string())
    } else {
        engine
    };

    let new_agent_id = format!("vc-{}", Uuid::new_v4());

    let started = Instant::now();
    let current_members = hub.registry.list_team_members(&ctx.team_id);
    // Issue #423: 引き継ぎのため singleton=false で登録。同チームに leader が
    // 2 人並ぶ過渡状態を許容する (`team_switch_leader` で旧 leader を retire するまで)。
    let channels = match hub
        .try_register_pending_recruit(
            new_agent_id.clone(),
            ctx.team_id.clone(),
            role_profile_id.clone(),
            ctx.agent_id.clone(),
            false,
            &current_members,
        )
        .await
    {
        Ok(c) => c,
        Err(e) => return Err(e),
    };
    let rx = channels.handshake;
    let ack_rx = channels.ack;

    let app = hub.app_handle.lock().await.clone();
    if let Some(app) = &app {
        let payload = json!({
            "teamId": ctx.team_id,
            "requesterAgentId": ctx.agent_id,
            "requesterRole": ctx.role,
            "newAgentId": new_agent_id,
            "roleProfileId": role_profile_id,
            "engine": resolved_engine,
            "agentLabelHint": agent_label_hint,
            "dynamicRole": Value::Null,
        });
        if let Err(e) = app.emit("team:recruit-request", payload) {
            hub.cancel_pending_recruit(&new_agent_id).await;
            return Err(format!("failed to emit recruit-request: {e}"));
        }
    } else {
        hub.cancel_pending_recruit(&new_agent_id).await;
        return Err("renderer not available (canvas mode required)".into());
    }

    // ack 待機 (renderer が `team:recruit-request` を受領 → addCard 開始)
    match tokio::time::timeout(RECRUIT_ACK_TIMEOUT, ack_rx).await {
        Ok(Ok(ack)) if ack.ok => {}
        Ok(Ok(ack)) => {
            hub.cancel_pending_recruit(&new_agent_id).await;
            let phase_str = ack
                .phase
                .map(|p| p.as_str().to_string())
                .unwrap_or_else(|| "unknown".to_string());
            let reason = ack.reason.unwrap_or_default();
            if let Some(app) = &app {
                let _ = app.emit(
                    "team:recruit-cancelled",
                    json!({ "newAgentId": new_agent_id, "reason": phase_str }),
                );
            }
            let message = if reason.is_empty() {
                format!("create_leader failed (phase={phase_str})")
            } else {
                format!("create_leader failed: {reason}")
            };
            return Err(RecruitError {
                code: "create_leader_failed".into(),
                message,
                phase: Some(phase_str),
                elapsed_ms: Some(started.elapsed().as_millis() as u64),
            }
            .into_err_string());
        }
        Ok(Err(_)) => {
            hub.cancel_pending_recruit(&new_agent_id).await;
            if let Some(app) = &app {
                let _ = app.emit(
                    "team:recruit-cancelled",
                    json!({ "newAgentId": new_agent_id, "reason": "ack_dropped" }),
                );
            }
            return Err(RecruitError {
                code: "create_leader_ack_dropped".into(),
                message: "renderer ack channel was dropped before reply".into(),
                phase: Some("ack".into()),
                elapsed_ms: Some(started.elapsed().as_millis() as u64),
            }
            .into_err_string());
        }
        Err(_) => {
            hub.cancel_pending_recruit(&new_agent_id).await;
            if let Some(app) = &app {
                let _ = app.emit(
                    "team:recruit-cancelled",
                    json!({ "newAgentId": new_agent_id, "reason": "ack_timeout" }),
                );
            }
            return Err(RecruitError {
                code: "create_leader_ack_timeout".into(),
                message: format!(
                    "renderer did not ack recruit-request within {}s",
                    RECRUIT_ACK_TIMEOUT.as_secs()
                ),
                phase: Some("ack".into()),
                elapsed_ms: Some(started.elapsed().as_millis() as u64),
            }
            .into_err_string());
        }
    }

    // handshake 完了待機 (新 leader の MCP bridge が hub に繋いでくる)
    match tokio::time::timeout(RECRUIT_TIMEOUT, rx).await {
        Ok(Ok(outcome)) => {
            let diag = hub.get_member_diagnostics(&outcome.agent_id).await;
            let recruited_at = diag
                .as_ref()
                .map(|d| d.recruited_at.clone())
                .unwrap_or_default();
            let handshake_at = diag.and_then(|d| d.last_handshake_at);
            if let Some(handoff_id) = &handoff_id {
                if let Err(e) = hub
                    .record_handoff_lifecycle(
                        &ctx.team_id,
                        handoff_id,
                        "created",
                        Some(outcome.agent_id.clone()),
                        Some("replacement leader created".into()),
                    )
                    .await
                {
                    tracing::warn!("[team_create_leader] handoff lifecycle update failed: {e}");
                }
            }
            Ok(json!({
                "success": true,
                "agentId": outcome.agent_id,
                "roleProfileId": outcome.role_profile_id,
                "recruitedAt": recruited_at,
                "handshakeAt": handshake_at,
                "handoffId": handoff_id,
            }))
        }
        Ok(Err(_)) => {
            hub.cancel_pending_recruit(&new_agent_id).await;
            Err(RecruitError {
                code: "create_leader_cancelled".into(),
                message: "create_leader cancelled before handshake".into(),
                phase: Some("handshake".into()),
                elapsed_ms: Some(started.elapsed().as_millis() as u64),
            }
            .into_err_string())
        }
        Err(_) => {
            hub.cancel_pending_recruit(&new_agent_id).await;
            if let Some(app) = &app {
                let _ = app.emit(
                    "team:recruit-cancelled",
                    json!({ "newAgentId": new_agent_id, "reason": "handshake_timeout" }),
                );
            }
            Err(RecruitError {
                code: "create_leader_handshake_timeout".into(),
                message: format!(
                    "new leader did not handshake within {}s",
                    RECRUIT_TIMEOUT.as_secs()
                ),
                phase: Some("handshake".into()),
                elapsed_ms: Some(started.elapsed().as_millis() as u64),
            }
            .into_err_string())
        }
    }
}

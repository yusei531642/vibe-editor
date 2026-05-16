//! tool: `team_create_leader` — Issue #423: 現 Leader が引き継ぎのために
//! 「同チームの新 Leader」を 1 人だけ追加で採用する MCP tool。
//!
//! `team_recruit` を leader role 専用 + singleton bypass で薄くラップしたもの。
//! 通常の `team_recruit(role_id="leader")` は singleton 制約に引っかかるため、
//! 引き継ぎ過渡状態 (旧+新 leader が一時的に並ぶ) を作るには専用経路が必要。
//!
//! 旧 leader はこの tool で新 leader を作ったあと `team_switch_leader` で
//! active leader を切り替え、自身のカードを retire する流れを想定する。

use crate::team_hub::{CallContext, EnginePolicy, EnginePolicyKind, TeamHub};
use serde_json::{json, Value};
use std::time::Instant;
use tauri::Emitter;
use uuid::Uuid;

use super::super::consts::RECRUIT_TIMEOUT;
use super::super::permissions::{check_permission, Permission};
use super::error::RecruitError;
use super::recruit::recruit_ack_timeout;

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
) -> Result<Value, RecruitError> {
    if let Err(e) = check_permission(&ctx.role, Permission::Recruit) {
        return Err(RecruitError::permission_denied(
            "create_leader",
            &e.role,
            "create leader",
        ));
    }

    // Issue #576: 同チーム内の同時 recruit / create_leader を team_id 単位 semaphore で
    // 順番待ち化する (`team_recruit` と同じ semaphore を共有 → 引き継ぎ用 leader spawn 中に
    // HR が並列 recruit を投げても renderer の event queue が詰まらない)。
    // 関数末尾まで `_permit` で束ねて Drop で自動解放させる。
    let _permit = match hub.acquire_recruit_permit(&ctx.team_id).await {
        Ok(p) => p,
        Err(msg) => {
            return Err(
                RecruitError::new("create_leader_permit_timeout", msg).with_phase("permit"),
            );
        }
    };

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

    // Issue #518: 任意引数 `engine_policy: { kind, defaultEngine? }` を受け取り、team に保存する。
    // 形式: `{"kind":"claude_only"|"codex_only"|"mixed_allowed", "defaultEngine":"claude"|"codex"|""}`
    // チーム作成時 (新規 leader) / 引き継ぎ時 (replacement leader) のどちらでも policy 上書きを許す。
    // 引数省略時は既存 policy を維持する (= 何もしない)。
    if let Some(policy_value) = args.get("engine_policy").or_else(|| args.get("enginePolicy")) {
        let parsed_policy = parse_engine_policy_value(policy_value)?;
        if let Err(e) = parsed_policy.validate(&engine) {
            return Err(RecruitError::new("create_leader_engine_policy_violation", e)
                .with_phase("engine_policy"));
        }
        hub.set_engine_policy(&ctx.team_id, parsed_policy).await;
    }

    // builtin の leader profile から default engine を引く
    let summary = hub.get_role_profile_summary().await;
    let target = summary.iter().find(|p| p.id == role_profile_id);
    // Issue #518: 上で set されたばかり (or 既存) の policy を尊重して既定 engine を解決する。
    let engine_policy = hub.get_engine_policy(&ctx.team_id).await;
    let role_default_engine = target
        .map(|t| t.default_engine.clone())
        .unwrap_or_else(|| "claude".to_string());
    let resolved_engine = if engine.is_empty() {
        engine_policy.resolve_default_engine(&role_default_engine)
    } else {
        engine
    };
    // engine 引数が policy 違反になっていないかも改めて検証する (set 後の policy 基準)。
    if let Err(e) = engine_policy.validate(&resolved_engine) {
        return Err(RecruitError::new("create_leader_engine_policy_violation", e)
            .with_phase("engine_policy"));
    }

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
        // Issue #737: `try_register_pending_recruit` は hub 内部関数で `Result<_, String>` を
        // 返す。generic な `tool_error` code で包んで RecruitError へ持ち上げる。
        Err(e) => return Err(e.into()),
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
            return Err(RecruitError::new(
                "create_leader_emit_failed",
                format!("failed to emit recruit-request: {e}"),
            ));
        }
    } else {
        hub.cancel_pending_recruit(&new_agent_id).await;
        return Err("renderer not available (canvas mode required)".into());
    }

    // ack 待機 (renderer が `team:recruit-request` を受領 → addCard 開始)
    // Issue #574: timeout 値は `recruit_ack_timeout()` (env override 込み、default 15s)。
    let ack_timeout = recruit_ack_timeout();
    match tokio::time::timeout(ack_timeout, ack_rx).await {
        Ok(Ok(ack)) if ack.ok => {
            let elapsed_ms = started.elapsed().as_millis() as u64;
            tracing::info!(
                "[teamhub] recruit_ack received agent_id={new_agent_id} \
                 team_id={team_id} elapsed_ms={elapsed_ms}",
                team_id = ctx.team_id,
            );
        }
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
            });
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
            });
        }
        Err(_) => {
            let elapsed_ms = started.elapsed().as_millis() as u64;
            tracing::info!(
                "[teamhub] recruit_ack timed_out agent_id={new_agent_id} \
                 team_id={team_id} elapsed_ms={elapsed_ms}",
                team_id = ctx.team_id,
            );
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
                    ack_timeout.as_secs()
                ),
                phase: Some("ack".into()),
                elapsed_ms: Some(elapsed_ms),
            });
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
            })
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
            })
        }
    }
}

/// Issue #518: `team_create_leader({engine_policy: {...}})` の任意引数を `EnginePolicy` に
/// パースする。値が object でない / `kind` が不正なら `create_leader_invalid_engine_policy`
/// エラー。`defaultEngine` は省略可 (ClaudeOnly / CodexOnly のときは自動で対応する engine が
/// resolve される)、明示する場合は "claude" / "codex" のみ許可。
fn parse_engine_policy_value(v: &Value) -> Result<EnginePolicy, RecruitError> {
    let obj = v.as_object().ok_or_else(|| {
        RecruitError::invalid_args(
            "create_leader",
            "engine_policy must be an object: { kind, defaultEngine? }",
        )
    })?;
    let kind_str = obj
        .get("kind")
        .and_then(|x| x.as_str())
        .map(str::to_lowercase)
        .ok_or_else(|| {
            RecruitError::invalid_args(
                "create_leader",
                "engine_policy.kind is required (claude_only / codex_only / mixed_allowed)",
            )
        })?;
    let kind = match kind_str.as_str() {
        "claude_only" | "claudeonly" => EnginePolicyKind::ClaudeOnly,
        "codex_only" | "codexonly" => EnginePolicyKind::CodexOnly,
        "mixed_allowed" | "mixedallowed" => EnginePolicyKind::MixedAllowed,
        other => {
            return Err(RecruitError::invalid_args(
                "create_leader",
                format!(
                    "unknown engine_policy.kind '{other}' \
                     (expected: claude_only / codex_only / mixed_allowed)"
                ),
            ));
        }
    };
    // `defaultEngine` (camelCase / 正) と `default_engine` (snake_case / alias) の両 case を accept する。
    // 実装側ではどちらでも受け取れるが、SKILL.md / TS 型では camelCase を正として案内する。
    // **空文字列 `""` は Some(empty) ではなく field 省略 (= None) として扱う** ことで、TS 側
    // `defaultEngine?: 'claude' | 'codex'` (undefined = 未設定) と意味論を揃える。
    let default_engine_raw = obj
        .get("defaultEngine")
        .or_else(|| obj.get("default_engine"))
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if let Some(ref de) = default_engine_raw {
        if de != "claude" && de != "codex" {
            return Err(RecruitError::invalid_args(
                "create_leader",
                format!(
                    "engine_policy.defaultEngine must be 'claude' or 'codex' (or omit the field), got '{de}'"
                ),
            ));
        }
    }
    Ok(EnginePolicy {
        kind,
        default_engine: default_engine_raw,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_claude_only_policy() {
        let v = json!({ "kind": "claude_only" });
        let p = parse_engine_policy_value(&v).unwrap();
        assert_eq!(p.kind, EnginePolicyKind::ClaudeOnly);
        assert_eq!(p.default_engine, None);
    }

    #[test]
    fn parse_codex_only_with_default_engine_camel() {
        let v = json!({ "kind": "codex_only", "defaultEngine": "codex" });
        let p = parse_engine_policy_value(&v).unwrap();
        assert_eq!(p.kind, EnginePolicyKind::CodexOnly);
        assert_eq!(p.default_engine.as_deref(), Some("codex"));
    }

    #[test]
    fn parse_mixed_allowed_with_snake_case_alias() {
        // snake_case `default_engine` も alias として accept される (camelCase が正)。
        let v = json!({ "kind": "mixed_allowed", "default_engine": "claude" });
        let p = parse_engine_policy_value(&v).unwrap();
        assert_eq!(p.kind, EnginePolicyKind::MixedAllowed);
        assert_eq!(p.default_engine.as_deref(), Some("claude"));
    }

    #[test]
    fn parse_empty_string_default_engine_normalizes_to_none() {
        // 空文字列 / 全空白は None として扱う (TS 側 `defaultEngine?: 'claude' | 'codex'` と整合)。
        let v = json!({ "kind": "mixed_allowed", "defaultEngine": "" });
        let p = parse_engine_policy_value(&v).unwrap();
        assert_eq!(p.default_engine, None);
        let v2 = json!({ "kind": "mixed_allowed", "defaultEngine": "   " });
        let p2 = parse_engine_policy_value(&v2).unwrap();
        assert_eq!(p2.default_engine, None);
    }

    #[test]
    fn parse_rejects_unknown_kind() {
        let v = json!({ "kind": "claude_or_codex" });
        let err = parse_engine_policy_value(&v).unwrap_err();
        assert_eq!(err.code, "create_leader_invalid_args");
        assert!(err.message.contains("unknown engine_policy.kind"));
    }

    #[test]
    fn parse_rejects_missing_kind() {
        let v = json!({ "defaultEngine": "claude" });
        let err = parse_engine_policy_value(&v).unwrap_err();
        assert!(err.message.contains("engine_policy.kind is required"));
    }

    #[test]
    fn parse_rejects_invalid_default_engine() {
        let v = json!({ "kind": "mixed_allowed", "defaultEngine": "gpt" });
        let err = parse_engine_policy_value(&v).unwrap_err();
        assert!(err.message.contains("must be 'claude' or 'codex'"));
    }

    #[test]
    fn parse_rejects_non_object() {
        let v = json!("claude_only");
        let err = parse_engine_policy_value(&v).unwrap_err();
        assert!(err.message.contains("must be an object"));
    }

    #[test]
    fn engine_policy_validate_blocks_violation() {
        let p = EnginePolicy {
            kind: EnginePolicyKind::CodexOnly,
            default_engine: Some("codex".into()),
        };
        assert!(p.validate("claude").is_err());
        assert!(p.validate("codex").is_ok());
    }

    #[test]
    fn engine_policy_resolve_default_engine() {
        let p = EnginePolicy {
            kind: EnginePolicyKind::CodexOnly,
            default_engine: Some("codex".into()),
        };
        assert_eq!(p.resolve_default_engine("claude"), "codex");
        let p2 = EnginePolicy {
            kind: EnginePolicyKind::MixedAllowed,
            default_engine: None,
        };
        assert_eq!(p2.resolve_default_engine("claude"), "claude");
        let p3 = EnginePolicy {
            kind: EnginePolicyKind::MixedAllowed,
            default_engine: Some("codex".into()),
        };
        assert_eq!(p3.resolve_default_engine("claude"), "codex");
    }
}

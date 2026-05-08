//! tool: `team_recruit` — define + hire a worker (動的ロール検証 + handshake 待機)。
//!
//! Issue #373 Phase 2 で `protocol.rs` から切り出し。

use crate::team_hub::{CallContext, DynamicRole, TeamHub};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tauri::Emitter;
use uuid::Uuid;

use super::super::consts::RECRUIT_ACK_TIMEOUT;
use super::super::consts::RECRUIT_TIMEOUT;
use super::super::dynamic_role::{validate_and_register_dynamic_role, DynamicRoleOutcome};
use super::super::instruction_lint::{lint_all, LintReport};
use super::super::permissions::{check_permission, Permission};
use super::super::role_template::TemplateFinding;
use super::error::RecruitError;
use crate::team_hub::role_lint::{compute_role_overlap, RoleSnapshot};

const DEFAULT_WAIT_POLICY: &str = "strict";

/// Issue #574: `RECRUIT_ACK_TIMEOUT` の実行時値を env override 込みで返す。
///
/// `VIBE_TEAM_RECRUIT_ACK_TIMEOUT_SECS` を u64 秒として読み出し、`>= 1` の値が
/// パースできればその Duration を返す。未設定 / パース失敗 / 0 のときは
/// `RECRUIT_ACK_TIMEOUT` (= 15s) を返す。
///
/// `team_recruit` / `team_create_leader` の双方から参照される共通入口。
pub(super) fn recruit_ack_timeout() -> Duration {
    std::env::var("VIBE_TEAM_RECRUIT_ACK_TIMEOUT_SECS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .filter(|&secs| secs > 0)
        .map(Duration::from_secs)
        .unwrap_or(RECRUIT_ACK_TIMEOUT)
}

fn parse_wait_policy(args: &Value) -> Result<String, String> {
    let raw = args
        .get("wait_policy")
        .or_else(|| args.get("waitPolicy"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or(DEFAULT_WAIT_POLICY);
    match raw {
        "strict" | "standard" | "proactive" => Ok(raw.to_string()),
        other => Err(RecruitError::new(
            "recruit_invalid_wait_policy",
            format!("wait_policy must be strict, standard, or proactive (got {other:?})"),
        )
        .with_phase("args")
        .into_err_string()),
    }
}

/// team_recruit: 新メンバーをチームに追加する。Renderer に event::emit でカード生成を依頼し、
/// その新 agentId が handshake してくるまで oneshot で待機 (timeout 30s)。
///
/// フラット引数の API:
///   - role_id (必須): snake_case 識別子。既存 (leader/hr/動的ロール) を再利用する場合はこれだけで OK。
///   - engine: claude / codex。省略時は role の default、それも無ければ claude。
///   - label / description / instructions: 揃っていれば「動的ロール定義 + 採用」を 1 コールで実行。
///     既存 role_id と被る場合は「既に存在する」エラーになる。
///   - instructions_ja: 任意の日本語版 instructions。
///   - agent_label_hint: 任意。canvas カードのタイトル上書き。
pub async fn team_recruit(hub: &TeamHub, ctx: &CallContext, args: &Value) -> Result<Value, String> {
    check_permission(&ctx.role, Permission::Recruit).map_err(|e| e.into_message("recruit"))?;
    // role_id を主引数とする。後方互換のため `role_profile_id` も受け付ける。
    let role_profile_id = args
        .get("role_id")
        .and_then(|v| v.as_str())
        .or_else(|| args.get("role_profile_id").and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string();
    if role_profile_id.is_empty() {
        return Err("role_id is required".into());
    }
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
    let wait_policy = parse_wait_policy(args)?;

    // フラット引数で動的ロール定義が同梱されているか判定。
    // label / description / instructions が「いずれか」あれば「全て揃っている必要がある」とみなしてバリデート。
    let label = args
        .get("label")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let description = args
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let instructions = args
        .get("instructions")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let instructions_ja = args
        .get("instructions_ja")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let any_def_field = !label.is_empty() || !description.is_empty() || !instructions.is_empty();
    let all_def_fields = !label.is_empty() && !description.is_empty() && !instructions.is_empty();
    if any_def_field && !all_def_fields {
        return Err(
            "to define a new role, all of label / description / instructions must be provided"
                .into(),
        );
    }

    // Issue #519: 動的ロール定義の instructions に「報告は不要」「ユーザー確認なしで」等の
    // 禁止句 (= 絶対ルール上書き / 報告経路切断 / 確認スキップ / 破壊的自走) が含まれていれば
    // 登録前に弾く。warn 段階のフレーズは登録は通すが lint_warnings として response に同梱する。
    //
    // 既存 role_id 再採用 (instructions が空文字) では findings は出ない。
    let lint_report: LintReport = if all_def_fields {
        let report = lint_all(&instructions, instructions_ja.as_deref());
        if report.has_deny() {
            return Err(
                RecruitError::new("recruit_lint_denied", report.deny_message())
                    .with_phase("lint")
                    .into_err_string(),
            );
        }
        report
    } else {
        LintReport::default()
    };

    // 動的ロール定義が揃っていれば「設計 + 採用」を 1 ステップで実行。
    // - Leader が「役職を考える」と「採用する」を別ターンで分けると LLM の往復が増えてエラーが増える。
    //   1 コール完結にすることで、Leader の発話オーバーヘッドとエラーリスクを最小化する。
    //
    // Issue #508: validate_and_register_dynamic_role は内部で必須テンプレ validation を行い、
    // deny 句があれば構造化エラー (recruit_role_too_vague) を Err で返す。warn は outcome の
    // template_warnings に乗って戻ってくるので、recruit response に同梱する。
    let (dynamic_role, template_warnings): (Option<DynamicRole>, Vec<TemplateFinding>) =
        if all_def_fields {
            let DynamicRoleOutcome {
                role,
                template_warnings,
            } = validate_and_register_dynamic_role(
                hub,
                ctx,
                &role_profile_id,
                &label,
                &description,
                &instructions,
                instructions_ja.as_deref(),
            )
            .await?;
            (Some(role), template_warnings)
        } else {
            (None, Vec::new())
        };

    // Issue #517: 採用時の責務境界 lint。新規動的ロール登録時のみ実行 (既存 role 再採用は対象外)。
    // 同 team の既存 dynamic role 群との Jaccard 類似度を計算し、閾値超過なら warn を返す。
    // 拒否はせず recruit を続行する (偽陽性での操作妨害を避けるため)。
    let boundary_report = if let Some(d) = &dynamic_role {
        let new_snapshot = RoleSnapshot {
            role_id: d.id.clone(),
            label: d.label.clone(),
            description: d.description.clone(),
            instructions: d.instructions.clone(),
        };
        // 同 team の既存動的ロールを snapshot 化 (validate_and_register が register 済なので
        // new_snapshot 自体もこの list に含まれている可能性がある — compute_role_overlap が
        // role_id 一致で skip するので二重カウントはしない)。
        let existing: Vec<RoleSnapshot> = hub
            .get_dynamic_roles(&ctx.team_id)
            .await
            .into_iter()
            .map(|r| RoleSnapshot {
                role_id: r.id,
                label: r.label,
                description: r.description,
                instructions: r.instructions,
            })
            .collect();
        compute_role_overlap(&new_snapshot, &existing)
    } else {
        Default::default()
    };

    // 警告があれば renderer に event 通知 (Canvas UI で toast 表示)。
    if !boundary_report.is_empty() {
        let app = hub.app_handle.lock().await.clone();
        if let Some(app) = &app {
            let summary = boundary_report
                .warn_message("採用時の責務境界 warning")
                .unwrap_or_default();
            let payload = json!({
                "teamId": ctx.team_id,
                "source": "recruit",
                "roleId": role_profile_id,
                "message": summary,
                "findings": boundary_report.findings,
            });
            if let Err(e) = app.emit("team:role-lint-warning", payload) {
                tracing::warn!("emit team:role-lint-warning failed: {e}");
            }
        }
    }

    // role profile の検証: builtin (summary) もしくは team スコープの動的ロールに在籍していること。
    let summary = hub.get_role_profile_summary().await;
    let summary_match = summary.iter().find(|p| p.id == role_profile_id).cloned();
    let dynamic_match = if summary_match.is_none() {
        // role_definition で今 register したばかりなら dynamic_role にも入っているし、
        // 過去の team_create_role による既存ロールもここに含まれる
        hub.get_dynamic_role(&ctx.team_id, &role_profile_id).await
    } else {
        None
    };
    if summary_match.is_none() && dynamic_match.is_none() {
        return Err(format!(
            "unknown role_profile_id: {role_profile_id} (call team_create_role first, or pass role_definition to team_recruit)"
        ));
    }

    // singleton / default_engine は builtin にしか無いので summary 側だけで判定する
    let target = summary_match.as_ref();
    let is_singleton = target.map(|t| t.singleton).unwrap_or(false);

    // Issue #518: チーム単位の engine policy を取得。`MixedAllowed` (default) なら従来通り、
    // `ClaudeOnly` / `CodexOnly` ならここで policy 違反 / 既定 engine を強制する。
    let engine_policy = hub.get_engine_policy(&ctx.team_id).await;

    // engine: 引数省略時は role profile の default。動的ロールは builtin と違い default を
    // 持たないので claude を既定にする。Issue #518: ClaudeOnly / CodexOnly の policy が立って
    // いるなら engine 引数省略時に role profile の default ではなく policy の既定を採用する
    // (HR が Codex-only チームで「engine 省略 → claude にリセット」する事故を構造的に消す)。
    let role_default_engine = target
        .map(|t| t.default_engine.clone())
        .unwrap_or_else(|| "claude".to_string());
    let resolved_engine = if engine.is_empty() {
        engine_policy.resolve_default_engine(&role_default_engine)
    } else {
        engine
    };

    // Issue #518: 解決後の engine が policy に違反していれば構造化エラーで拒否する。
    // 引数で明示的に違反 engine を渡された場合 (例: CodexOnly チームで engine="claude") に
    // ハード拒否し、HR / Leader が誤って混合してしまう経路を構造的に潰す。
    if let Err(msg) = engine_policy.validate(&resolved_engine) {
        return Err(RecruitError::new("recruit_engine_policy_violation", msg)
            .with_phase("engine_policy")
            .into_err_string());
    }

    // 動的ロールの場合は agent_label_hint をロール label で補完する (renderer 側カード表示が綺麗になる)
    let agent_label_hint = if agent_label_hint.is_empty() {
        if let Some(d) = &dynamic_role {
            d.label.clone()
        } else if let Some(d) = &dynamic_match {
            d.label.clone()
        } else {
            String::new()
        }
    } else {
        agent_label_hint
    };

    // 新 agentId を採番 (vc- prefix で他システムと区別)
    let new_agent_id = format!("vc-{}", Uuid::new_v4());

    // Issue #122: 「singleton 重複チェック」と「pending 登録」を同じクリティカルセクションで実行。
    // pending recruit も singleton の判定対象に含めることで、並行 team_recruit が
    // 両方 pass して singleton 重複が発生する競合を防ぐ。
    //
    // Issue #386: 1 チームあたりのメンバー人数上限 (旧 MAX_MEMBERS_PER_TEAM=12) は撤廃済み。
    //
    // Issue #342 Phase 1: ack 駆動への移行に伴い、handshake 用の `rx` に加えて renderer 側
    // `app_recruit_ack` invoke を待つ `ack_rx` も同時に生成する。
    let started = Instant::now();
    let current_members = hub.registry.list_team_members(&ctx.team_id);
    let channels = match hub
        .try_register_pending_recruit(
            new_agent_id.clone(),
            ctx.team_id.clone(),
            role_profile_id.clone(),
            ctx.agent_id.clone(),
            is_singleton,
            &current_members,
        )
        .await
    {
        Ok(c) => c,
        Err(e) => return Err(e),
    };
    let rx = channels.handshake;
    let ack_rx = channels.ack;

    // 動的ロールであれば、その定義もペイロードに同梱する。renderer 側はこの payload を見て
    // RoleProfilesContext のメモリキャッシュへ追加し、worker template に instructions を流し込む。
    // (team:role-created を別 emit でも届けているが、recruit-request と同梱しておくと到達順に依存しない)
    let dynamic_role_payload = match (&dynamic_role, &dynamic_match) {
        (Some(d), _) | (_, Some(d)) => Some(json!({
            "id": d.id,
            "label": d.label,
            "description": d.description,
            "instructions": d.instructions,
            "instructionsJa": d.instructions_ja,
        })),
        _ => None,
    };

    // Renderer にカード生成を依頼
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
            "waitPolicy": wait_policy.clone(),
            "dynamicRole": dynamic_role_payload,
        });
        if let Err(e) = app.emit("team:recruit-request", payload) {
            hub.cancel_pending_recruit(&new_agent_id).await;
            return Err(format!("failed to emit recruit-request: {e}"));
        }
    } else {
        hub.cancel_pending_recruit(&new_agent_id).await;
        return Err("renderer not available (canvas mode required)".into());
    }

    // Issue #342 Phase 1 (1.11): 環境変数 `VIBE_TEAM_DISABLE_RECRUIT_ACK=1` で旧 fire-and-forget
    // 動作にフォールバック (ack 待ちをスキップしていきなり handshake 30s 待機)。緊急ロールバック用。
    let disable_ack = std::env::var("VIBE_TEAM_DISABLE_RECRUIT_ACK").as_deref() == Ok("1");

    if !disable_ack {
        // Issue #342 Phase 1: ack 短期待機。renderer が `team:recruit-request` を受領して
        // addCard / spawn を開始した時点で `app_recruit_ack(ok=true)` が来る。
        // ack 失敗 / timeout なら handshake を待たずに即座に構造化エラーを返す。
        // Issue #574: timeout 値は `recruit_ack_timeout()` (env override 込み、default 15s)。
        let ack_timeout = recruit_ack_timeout();
        match tokio::time::timeout(ack_timeout, ack_rx).await {
            Ok(Ok(ack)) if ack.ok => {
                // ack 受領 OK。続けて handshake 待機へ。
                // ※ ack=true は受領通知のみ。MCP 成功判定は依然 handshake 経由のみ。
                let elapsed_ms = started.elapsed().as_millis() as u64;
                tracing::info!(
                    "[teamhub] recruit_ack received agent_id={new_agent_id} \
                     team_id={team_id} elapsed_ms={elapsed_ms}",
                    team_id = ctx.team_id,
                );
            }
            Ok(Ok(ack)) => {
                // renderer から ack(ok=false) が来た = 起動失敗を即時通知された
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
                    format!("recruit failed (phase={phase_str})")
                } else {
                    format!("recruit failed: {reason}")
                };
                return Err(RecruitError::new("recruit_failed", message)
                    .with_phase(phase_str)
                    .with_elapsed_ms(started.elapsed().as_millis() as u64)
                    .into_err_string());
            }
            Ok(Err(_)) => {
                // ack_tx が drop された (renderer 側が pending を resolve せずに崩壊) — 緊急 cancel 扱い
                hub.cancel_pending_recruit(&new_agent_id).await;
                if let Some(app) = &app {
                    let _ = app.emit(
                        "team:recruit-cancelled",
                        json!({ "newAgentId": new_agent_id, "reason": "ack_dropped" }),
                    );
                }
                return Err(RecruitError::new(
                    "recruit_ack_dropped",
                    "renderer ack channel was dropped before reply",
                )
                .with_phase("ack")
                .with_elapsed_ms(started.elapsed().as_millis() as u64)
                .into_err_string());
            }
            Err(_) => {
                // ack timeout。renderer が `team:recruit-request` を受け取れていない可能性。
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
                return Err(RecruitError::new(
                    "recruit_ack_timeout",
                    format!(
                        "renderer did not ack recruit-request within {}s",
                        ack_timeout.as_secs()
                    ),
                )
                .with_phase("ack")
                .with_elapsed_ms(elapsed_ms)
                .into_err_string());
            }
        }
    }

    // handshake 完了を待つ (Issue #342 Phase 1: ack 成功後のみ到達。disable_ack=1 では従来通り即座に到達)
    match tokio::time::timeout(RECRUIT_TIMEOUT, rx).await {
        Ok(Ok(outcome)) => {
            // Issue #342 Phase 3 (3.6): 成功時に recruitedAt / handshakeAt を返す。
            // recruited_at は registry 登録時刻、handshakeAt は handshake 完了時刻。
            // どちらも `resolve_pending_recruit` で member_diagnostics に書き込み済み。
            let diag = hub.get_member_diagnostics(&outcome.agent_id).await;
            let recruited_at = diag
                .as_ref()
                .map(|d| d.recruited_at.clone())
                .unwrap_or_default();
            let handshake_at = diag.and_then(|d| d.last_handshake_at);
            // Issue #519: warn 段階の lint findings を response に同梱。renderer / Leader が
            // この警告を読み取り、必要なら Leader 自身が dismiss/再採用で訂正できるようにする。
            let lint_warnings: Vec<String> = lint_report
                .warnings()
                .into_iter()
                .map(|f| format!("'{}' ({})", f.phrase, f.category))
                .collect();
            let lint_warning_message = lint_report.warn_message();
            // Issue #508: template validation の warn findings も同梱。lint と同じ構造で渡す。
            let template_warning_strs: Vec<String> = template_warnings
                .iter()
                .map(|f| format!("[{}] {}", f.category, f.detail))
                .collect();
            let template_warning_message = if template_warnings.is_empty() {
                None
            } else {
                Some(format!(
                    "dynamic role template warnings (continuing recruit): {}",
                    template_warning_strs.join("; ")
                ))
            };
            // Issue #517: 責務境界 lint の warn findings も同梱。
            let boundary_warning_strs = boundary_report.finding_strings();
            let boundary_warning_message =
                boundary_report.warn_message("role boundary warnings (continuing recruit)");
            Ok(json!({
                "success": true,
                "agentId": outcome.agent_id,
                "roleProfileId": outcome.role_profile_id,
                "recruitedAt": recruited_at,
                "handshakeAt": handshake_at,
                "lintWarnings": lint_warnings,
                "lintWarningMessage": lint_warning_message,
                "templateWarnings": template_warning_strs,
                "templateWarningMessage": template_warning_message,
                "boundaryWarnings": boundary_warning_strs,
                "boundaryWarningMessage": boundary_warning_message,
                "waitPolicy": wait_policy,
            }))
        }
        Ok(Err(_)) => {
            // Issue #173: sender dropped 経路でも pending を必ず掃除する。
            // 旧実装は cancel_pending_recruit を呼ばずに Err を返していたため、
            // 孤立 pending が try_register_pending_recruit の人数/singleton 判定に
            // 永久カウントされ、再起動まで採用不能化していた。
            hub.cancel_pending_recruit(&new_agent_id).await;
            // Issue #342 Phase 1: 構造化エラーで返す (cancelled は handshake 直前 cancel 等)
            Err(
                RecruitError::new("recruit_cancelled", "recruit cancelled before handshake")
                    .with_phase("handshake")
                    .with_elapsed_ms(started.elapsed().as_millis() as u64)
                    .into_err_string(),
            )
        }
        Err(_) => {
            // timeout
            hub.cancel_pending_recruit(&new_agent_id).await;
            // renderer にも cancel イベントを emit してカードを撤収させる
            if let Some(app) = &app {
                let _ = app.emit(
                    "team:recruit-cancelled",
                    json!({ "newAgentId": new_agent_id, "reason": "handshake_timeout" }),
                );
            }
            // Issue #342 Phase 1: 構造化エラー化
            Err(RecruitError::new(
                "recruit_handshake_timeout",
                format!(
                    "agent did not handshake within {}s",
                    RECRUIT_TIMEOUT.as_secs()
                ),
            )
            .with_phase("handshake")
            .with_elapsed_ms(started.elapsed().as_millis() as u64)
            .into_err_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_wait_policy, DEFAULT_WAIT_POLICY};
    use serde_json::json;

    #[test]
    fn parse_wait_policy_defaults_to_strict() {
        assert_eq!(
            parse_wait_policy(&json!({})).unwrap(),
            DEFAULT_WAIT_POLICY.to_string()
        );
    }

    #[test]
    fn parse_wait_policy_accepts_camel_case_key() {
        assert_eq!(
            parse_wait_policy(&json!({ "waitPolicy": "proactive" })).unwrap(),
            "proactive"
        );
    }

    #[test]
    fn parse_wait_policy_rejects_unknown_value() {
        let err = parse_wait_policy(&json!({ "wait_policy": "autonomous" })).unwrap_err();

        assert!(err.contains("recruit_invalid_wait_policy"));
        assert!(err.contains("strict, standard, or proactive"));
    }
}

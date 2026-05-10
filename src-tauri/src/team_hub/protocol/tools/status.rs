//! tool: `team_status` — 自己申告ステータスを Hub に保存し、
//! `team_diagnostics` 経由で Leader が「直近で生きていて何をしているか」を判別できるようにする。
//!
//! Issue #373 Phase 2 で `protocol.rs` のインライン実装から関数化 (旧来は no-op)。
//! Issue #409 で「実状態の記録」へ拡張。`current_status` と `last_status_at` を
//! `MemberDiagnostics` に保存する。`status` 引数は string 必須、空白 trim 後に空ならエラー。
//!
//! Issue #634 (Security): rate limit + length cap + control char strip を追加。
//! 攻撃的 / バグ持ち worker が連打して autoStale を偽装する経路、長文 + 制御文字
//! (ESC sequence 等) で diagnostic / log を破壊する経路を塞ぐ。

use crate::team_hub::{CallContext, TeamHub};
use chrono::Utc;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

/// Issue #634: `current_status` の最大長 (UTF-8 バイト数)。超過分は `… (truncated)` を末尾に付けて切る。
/// renderer 側 chat row はそもそも 1 行の現況メモなので 256 byte で十分。
const MAX_STATUS_LEN: usize = 256;

/// Issue #634: 同 agent_id からの `team_status` 連続呼び出しの最小間隔。
/// 3 秒 = autoStale 検知 (現状 60 秒級) を確実に成立させつつ、ack→in_progress→status 連発の
/// 通常ユースを誤検知しない値。
const MIN_STATUS_INTERVAL: Duration = Duration::from_secs(3);

/// Issue #634: `current_status` 文字列の sanitize。
/// 制御文字 (ESC / BEL / NUL / 改行 / DEL 等) を全削除し、log injection と
/// terminal escape sequence 経由の表示崩しを防ぐ。
fn sanitize_status_text(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).collect()
}

/// Issue #409: `team_status(status)` を呼んだ agent の自己申告ステータスを Hub に記録する。
///
/// 引数:
///   - `status` (string, required): 1 行の現況テキスト (例 "ACK: starting clone", "running cargo test").
///
/// 戻り値:
///   - `success`: バリデーション通過 + rate limit 通過なら true、rate limit reject なら false
///   - `recordedAt`: RFC3339 timestamp (rate limit reject 時は null)
///   - `currentStatus`: 保存された status 文字列 (trim 済み + sanitize 済み + truncate 済み)
///   - `truncated`: Issue #634 の length cap で切り詰めた場合 true
///   - `rateLimited`: Issue #634 の rate limit で reject した場合 true
///
/// 副作用:
///   - rate limit 通過時のみ呼び出し元 agent の `MemberDiagnostics.current_status` /
///     `last_status_at` / `last_seen_at` を更新する (= autoStale 偽装防止)
pub async fn team_status(
    hub: &TeamHub,
    ctx: &CallContext,
    args: &Value,
) -> Result<Value, String> {
    let status_raw = args.get("status").and_then(|v| v.as_str()).unwrap_or("");
    let status = status_raw.trim();
    if status.is_empty() {
        return Err("status is required and must be a non-empty string".to_string());
    }
    // Issue #634: control char strip → length cap (byte 単位)。
    // truncate は UTF-8 文字境界で行わないと panic するため、char_indices で安全に切る。
    let mut sanitized = sanitize_status_text(status);
    let truncated = sanitized.len() > MAX_STATUS_LEN;
    if truncated {
        let cut = sanitized
            .char_indices()
            .take_while(|(idx, _)| *idx <= MAX_STATUS_LEN)
            .last()
            .map(|(idx, ch)| idx + ch.len_utf8())
            .unwrap_or(0);
        sanitized.truncate(cut);
        sanitized.push_str(" … (truncated)");
    }

    let now_iso = Utc::now().to_rfc3339();
    let now_instant = Instant::now();
    {
        let mut state = hub.state.lock().await;
        // Issue #634: rate limit。`MIN_STATUS_INTERVAL` 以内の再呼び出しは last_status_at /
        // last_seen_at も更新せず silent reject (= autoStale 偽装を成立させない)。
        if let Some(last) = state.last_status_call_at.get(&ctx.agent_id) {
            if now_instant.duration_since(*last) < MIN_STATUS_INTERVAL {
                return Ok(json!({
                    "success": false,
                    "rateLimited": true,
                    "minIntervalSecs": MIN_STATUS_INTERVAL.as_secs(),
                    "currentStatus": sanitized,
                }));
            }
        }
        state
            .last_status_call_at
            .insert(ctx.agent_id.clone(), now_instant);
        let diag = state
            .member_diagnostics
            .entry(ctx.agent_id.clone())
            .or_default();
        diag.current_status = Some(sanitized.clone());
        diag.last_status_at = Some(now_iso.clone());
        diag.last_seen_at = Some(now_iso.clone());
    }
    Ok(json!({
        "success": true,
        "recordedAt": now_iso,
        "currentStatus": sanitized,
        "truncated": truncated,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty::SessionRegistry;
    use crate::team_hub::TeamHub;
    use std::sync::Arc;

    /// 最小の TeamHub を組み立てる (テスト専用)。
    /// 本物の listener / endpoint は要らないので、in-memory の state だけ初期化できれば十分。
    fn make_hub() -> TeamHub {
        TeamHub::new(Arc::new(SessionRegistry::new()))
    }

    #[tokio::test]
    async fn records_status_and_timestamp_in_diagnostics() {
        let hub = make_hub();
        let ctx = CallContext {
            agent_id: "agent-a".into(),
            role: "programmer".into(),
            team_id: "team-1".into(),
        };
        let args = json!({ "status": "running cargo test" });
        let result = team_status(&hub, &ctx, &args).await.expect("ok");
        assert_eq!(result["success"], json!(true));
        assert_eq!(result["currentStatus"], json!("running cargo test"));
        assert!(result["recordedAt"].as_str().is_some());

        let state = hub.state.lock().await;
        let diag = state
            .member_diagnostics
            .get("agent-a")
            .expect("diag entry created");
        assert_eq!(diag.current_status.as_deref(), Some("running cargo test"));
        assert!(diag.last_status_at.is_some());
        assert!(diag.last_seen_at.is_some());
    }

    #[tokio::test]
    async fn trims_whitespace_and_rejects_empty_status() {
        let hub = make_hub();
        let ctx = CallContext {
            agent_id: "agent-b".into(),
            role: "programmer".into(),
            team_id: "team-1".into(),
        };

        let trimmed = team_status(&hub, &ctx, &json!({ "status": "  hello  " }))
            .await
            .expect("ok");
        assert_eq!(trimmed["currentStatus"], json!("hello"));

        let empty = team_status(&hub, &ctx, &json!({ "status": "   " })).await;
        assert!(empty.is_err(), "empty status must be rejected");

        let missing = team_status(&hub, &ctx, &json!({})).await;
        assert!(missing.is_err(), "missing status must be rejected");
    }

    /// Issue #634: 連続呼び出し (`MIN_STATUS_INTERVAL` 以内) は rate limit で reject され、
    /// `last_status_at` / `last_seen_at` が **更新されないこと** (autoStale 偽装防止)。
    #[tokio::test]
    async fn rate_limits_burst_calls_and_does_not_refresh_last_status_at() {
        let hub = make_hub();
        let ctx = CallContext {
            agent_id: "agent-rate".into(),
            role: "programmer".into(),
            team_id: "team-1".into(),
        };
        // 1 回目は通る
        let first = team_status(&hub, &ctx, &json!({ "status": "alive" }))
            .await
            .expect("ok");
        assert_eq!(first["success"], json!(true));
        let first_at = {
            let state = hub.state.lock().await;
            state
                .member_diagnostics
                .get("agent-rate")
                .unwrap()
                .last_status_at
                .clone()
                .unwrap()
        };

        // 2 回目 (即座) は rate limit で reject。
        let second = team_status(&hub, &ctx, &json!({ "status": "still alive" }))
            .await
            .expect("ok response");
        assert_eq!(second["success"], json!(false));
        assert_eq!(second["rateLimited"], json!(true));

        // last_status_at は 1 回目のままで更新されていない (= autoStale 偽装が成立しない)。
        let after = {
            let state = hub.state.lock().await;
            state
                .member_diagnostics
                .get("agent-rate")
                .unwrap()
                .last_status_at
                .clone()
                .unwrap()
        };
        assert_eq!(
            after, first_at,
            "rate limited call must not refresh last_status_at"
        );
    }

    /// Issue #634: 制御文字 (ESC sequence / BEL / 改行) は strip されて diagnostics に
    /// 保存されないこと。renderer / log の表示崩しを防ぐ。
    #[tokio::test]
    async fn strips_control_characters_from_status_text() {
        let hub = make_hub();
        let ctx = CallContext {
            agent_id: "agent-ctrl".into(),
            role: "programmer".into(),
            team_id: "team-1".into(),
        };
        let evil = "running\x1b[2J\x07tests\nstill\x00going";
        let result = team_status(&hub, &ctx, &json!({ "status": evil }))
            .await
            .expect("ok");
        let saved = result["currentStatus"].as_str().unwrap().to_string();
        assert_eq!(
            saved, "runningteststillgoing",
            "control chars must be stripped (got: {saved:?})"
        );
    }

    /// Issue #634: 長文 (256 byte 超過) は truncate marker 付きで切り詰められること。
    #[tokio::test]
    async fn truncates_overlong_status_text_with_marker() {
        let hub = make_hub();
        let ctx = CallContext {
            agent_id: "agent-long".into(),
            role: "programmer".into(),
            team_id: "team-1".into(),
        };
        let long = "x".repeat(1024);
        let result = team_status(&hub, &ctx, &json!({ "status": long }))
            .await
            .expect("ok");
        assert_eq!(result["truncated"], json!(true));
        let saved = result["currentStatus"].as_str().unwrap();
        assert!(
            saved.contains("(truncated)"),
            "truncate marker should be appended, got len={}",
            saved.len()
        );
        // 切り詰め後の長さは MAX_STATUS_LEN + truncate marker 文字列分程度に収まる
        assert!(
            saved.len() <= MAX_STATUS_LEN + 32,
            "truncated body too long: {}",
            saved.len()
        );
    }
}

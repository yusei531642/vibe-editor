//! tool: `team_status` — 自己申告ステータスを Hub に保存し、
//! `team_diagnostics` 経由で Leader が「直近で生きていて何をしているか」を判別できるようにする。
//!
//! Issue #373 Phase 2 で `protocol.rs` のインライン実装から関数化 (旧来は no-op)。
//! Issue #409 で「実状態の記録」へ拡張。`current_status` と `last_status_at` を
//! `MemberDiagnostics` に保存する。`status` 引数は string 必須、空白 trim 後に空ならエラー。

use crate::team_hub::{CallContext, TeamHub};
use chrono::Utc;
use serde_json::{json, Value};

/// Issue #409: `team_status(status)` を呼んだ agent の自己申告ステータスを Hub に記録する。
///
/// 引数:
///   - `status` (string, required): 1 行の現況テキスト (例 "ACK: starting clone", "running cargo test").
///
/// 戻り値:
///   - `success`: 常に true (バリデーション失敗は Err で返す)
///   - `recordedAt`: RFC3339 timestamp
///   - `currentStatus`: 保存された status 文字列 (trim 済み)
///
/// 副作用:
///   - 呼び出し元 agent の `MemberDiagnostics.current_status` / `last_status_at` を更新
///   - `last_seen_at` も同時に更新 (heartbeat 兼)
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
    let now_iso = Utc::now().to_rfc3339();
    {
        let mut state = hub.state.lock().await;
        let diag = state
            .member_diagnostics
            .entry(ctx.agent_id.clone())
            .or_default();
        diag.current_status = Some(status.to_string());
        diag.last_status_at = Some(now_iso.clone());
        diag.last_seen_at = Some(now_iso.clone());
    }
    Ok(json!({
        "success": true,
        "recordedAt": now_iso,
        "currentStatus": status,
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
}

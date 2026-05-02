//! tool: `team_status` — informational status report (no-op success).
//!
//! Issue #373 Phase 2 で `protocol.rs::dispatch_tool` のインライン実装から関数化。

use crate::team_hub::{CallContext, TeamHub};
use serde_json::{json, Value};

pub async fn team_status(
    _hub: &TeamHub,
    _ctx: &CallContext,
    _args: &Value,
) -> Result<Value, String> {
    Ok(json!({ "success": true }))
}

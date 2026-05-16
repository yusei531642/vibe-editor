//! tool: `team_list_role_profiles` — list builtin + dynamic role profiles.
//!
//! Issue #373 Phase 2 で `protocol.rs` から切り出し。

use crate::team_hub::{CallContext, TeamHub};
use serde_json::{json, Value};

use super::error::ToolError;

pub async fn team_list_role_profiles(
    hub: &TeamHub,
    ctx: &CallContext,
) -> Result<Value, ToolError> {
    let summary = hub.get_role_profile_summary().await;
    let dynamic = hub.get_dynamic_roles(&ctx.team_id).await;
    let mut profiles: Vec<Value> = summary
        .iter()
        .map(|p| {
            json!({
                "id": p.id,
                "label": p.label_en,
                "labelJa": p.label_ja,
                "description": p.description_en,
                "descriptionJa": p.description_ja,
                "canRecruit": p.can_recruit,
                "canDismiss": p.can_dismiss,
                "canAssignTasks": p.can_assign_tasks,
                "canCreateRoleProfile": p.can_create_role_profile,
                "defaultEngine": p.default_engine,
                "singleton": p.singleton,
                "source": "builtin",
            })
        })
        .collect();
    // 同じ team で動的に作られたロールも返す。Leader の team_create_role 後に
    // HR が team_list_role_profiles を呼ぶフローで重要。
    for d in &dynamic {
        profiles.push(json!({
            "id": d.id,
            "label": d.label,
            "description": d.description,
            "canRecruit": false,
            "canDismiss": false,
            "canAssignTasks": false,
            "canCreateRoleProfile": false,
            "defaultEngine": "claude",
            "singleton": false,
            "source": "dynamic",
        }));
    }
    Ok(json!({ "profiles": profiles }))
}

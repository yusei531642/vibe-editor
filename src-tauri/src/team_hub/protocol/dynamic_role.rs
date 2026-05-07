//! 動的ロール (renderer が `team_recruit` 時に動的に登録するロール) の検証 + 登録。
//!
//! Issue #373 Phase 2 で `protocol.rs` から切り出し。
//!
//! 既存 builtin (summary 上) と被る role_id は拒否、上限超過も拒否、長さ上限も拒否する。

use crate::team_hub::{CallContext, DynamicRole, TeamHub};
use serde_json::json;
use tauri::Emitter;

use super::consts::{
    MAX_DYNAMIC_DESCRIPTION_LEN, MAX_DYNAMIC_INSTRUCTIONS_LEN, MAX_DYNAMIC_LABEL_LEN,
    MAX_DYNAMIC_ROLES_PER_TEAM,
};
use super::permissions::{check_permission, Permission};

/// 動的ロール定義 1 件を検証 + 登録。team_recruit の role_definition / team_create_role の両方から使う。
/// 既存 builtin (summary 上) と被る role_id は拒否、上限超過も拒否、長さ上限も拒否する。
pub(super) async fn validate_and_register_dynamic_role(
    hub: &TeamHub,
    ctx: &CallContext,
    role_id: &str,
    label: &str,
    description: &str,
    instructions: &str,
    instructions_ja: Option<&str>,
) -> Result<DynamicRole, String> {
    // 権限チェック (Leader だけが動的ロールを作れる)
    check_permission(&ctx.role, Permission::CreateRoleProfile)
        .map_err(|e| e.into_message("create role profiles"))?;
    // バリデーション: id
    let role_id = role_id.trim();
    if role_id.is_empty() {
        return Err("role_id is required".into());
    }
    if role_id.len() > 80 {
        return Err("role_id is too long (max 80)".into());
    }
    // ASCII alnum + _ - のみ許可 (`vc-` などのプレフィックスとの混同を避ける)
    if !role_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("role_id must contain only ASCII letters, digits, '_' or '-'".into());
    }
    // builtin との衝突 (summary に id が居れば builtin or override)
    let summary = hub.get_role_profile_summary().await;
    if summary.iter().any(|p| p.id == role_id) {
        return Err(format!(
            "role_id '{role_id}' is reserved by a built-in / existing role profile"
        ));
    }
    // 長さ上限
    if label.len() > MAX_DYNAMIC_LABEL_LEN {
        return Err(format!(
            "label too long: {} bytes (limit {})",
            label.len(),
            MAX_DYNAMIC_LABEL_LEN
        ));
    }
    if description.len() > MAX_DYNAMIC_DESCRIPTION_LEN {
        return Err(format!(
            "description too long: {} bytes (limit {})",
            description.len(),
            MAX_DYNAMIC_DESCRIPTION_LEN
        ));
    }
    if instructions.len() > MAX_DYNAMIC_INSTRUCTIONS_LEN {
        return Err(format!(
            "instructions too long: {} bytes (limit {})",
            instructions.len(),
            MAX_DYNAMIC_INSTRUCTIONS_LEN
        ));
    }
    if let Some(ja) = instructions_ja {
        if ja.len() > MAX_DYNAMIC_INSTRUCTIONS_LEN {
            return Err(format!(
                "instructions_ja too long: {} bytes (limit {})",
                ja.len(),
                MAX_DYNAMIC_INSTRUCTIONS_LEN
            ));
        }
    }
    // チームあたりの上限
    let existing = hub.get_dynamic_roles(&ctx.team_id).await;
    if existing.len() >= MAX_DYNAMIC_ROLES_PER_TEAM
        && !existing.iter().any(|r| r.id == role_id)
    {
        return Err(format!(
            "too many dynamic roles in this team ({}/{} max)",
            existing.len(),
            MAX_DYNAMIC_ROLES_PER_TEAM
        ));
    }
    let role = DynamicRole {
        id: role_id.to_string(),
        label: label.to_string(),
        description: description.to_string(),
        instructions: instructions.to_string(),
        instructions_ja: instructions_ja.map(|s| s.to_string()),
        team_id: ctx.team_id.clone(),
        created_by_role: ctx.role.clone(),
    };
    hub.register_dynamic_role(role.clone()).await;
    // renderer に通知 (UI 更新 + role-profiles-context 内のメモリキャッシュへ反映)
    let app = hub.app_handle.lock().await.clone();
    if let Some(app) = &app {
        let payload = json!({
            "teamId": role.team_id,
            "role": {
                "id": role.id,
                "label": role.label,
                "description": role.description,
                "instructions": role.instructions,
                "instructionsJa": role.instructions_ja,
                "teamId": role.team_id,
                "createdByRole": role.created_by_role,
            }
        });
        if let Err(e) = app.emit("team:role-created", payload) {
            tracing::warn!("emit team:role-created failed: {e}");
        }
    }
    Ok(role)
}

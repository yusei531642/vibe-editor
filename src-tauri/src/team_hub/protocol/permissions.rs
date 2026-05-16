//! Issue #136 (Security) + Issue #493: caller の role が要求された permission を持つか検証する。
//!
//! 旧実装は renderer から同期された `role_profile_summary` の can_* フラグを SSOT に
//! していた。renderer 内コード実行 (XSS 等) を獲得した攻撃者が任意 role に
//! canRecruit/canCreateRoleProfile=true を仕込んだ summary を Hub に同期し、
//! 任意 system prompt の worker を spawn できる権限昇格経路があった。
//!
//! 修正方針: permission は Rust 側の immutable builtin テーブルだけを参照し、
//! renderer の summary は UI label/desc 等の表示用途に限定する。動的 role は
//! 常に can_* = false 扱い (recruit / dismiss / role 作成は不可)。
//!
//! Issue #373 Phase 2 で `protocol.rs` から切り出し。
//! Issue #493: 旧 `caller_has_permission(_, role, "canRecruit")` の string-permission 引き渡しを
//! `check_permission(role, Permission::Recruit)` の type-safe enum に統一。
//! 各 tool は `check_permission()?` を呼んで `PermissionError::into_message("recruit")` 等で
//! "permission denied: role 'X' cannot Y" 形のエラーメッセージを生成する。

use std::fmt;

/// Hub 側で hardcode された権限カテゴリ。
///
/// 各 variant の `as_str()` は legacy 文字列キー (`canRecruit` 等) を返す。
/// renderer 側の `RoleProfileSummary.canRecruit` 等と一致させているが、Hub 側は
/// この enum を SSOT として扱い、renderer 文字列は信頼しない。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::team_hub) enum Permission {
    /// `canRecruit` — `team_recruit` / `team_create_leader` / `team_switch_leader` /
    /// `team_ack_handoff` で要求。
    Recruit,
    /// `canDismiss` — `team_dismiss` で要求。Leader 専権 (HR でも不可)。
    Dismiss,
    /// `canAssignTasks` — `team_assign_task` で要求。
    AssignTasks,
    /// `canCreateRoleProfile` — 動的ロール定義 (`validate_and_register_dynamic_role`) で要求。
    CreateRoleProfile,
    /// `canViewDiagnostics` — `team_diagnostics` で要求。server log path 等の秘匿パスを
    /// 一般 worker に晒さないために leader/hr のみ許可。
    ViewDiagnostics,
}

impl Permission {
    /// renderer 側 `RoleProfileSummary` フィールド名 (camelCase) と一致。
    /// 既存ログ / テストの "canXxx" 出力を維持するための文字列化。
    pub(in crate::team_hub) fn as_str(self) -> &'static str {
        match self {
            Self::Recruit => "canRecruit",
            Self::Dismiss => "canDismiss",
            Self::AssignTasks => "canAssignTasks",
            Self::CreateRoleProfile => "canCreateRoleProfile",
            Self::ViewDiagnostics => "canViewDiagnostics",
        }
    }
}

/// `check_permission` の失敗値。各 tool は `role` を使って
/// `ToolError::permission_denied(code_prefix, &e.role, action)` で構造化エラーを組み立てる
/// (Issue #737: 旧 `into_message` による生 String 化は廃止し、flat JSON の `ToolError` に統一)。
#[derive(Clone, Debug)]
pub(in crate::team_hub) struct PermissionError {
    pub role: String,
    pub permission: Permission,
}

impl fmt::Display for PermissionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "permission denied: role '{}' lacks permission {}",
            self.role,
            self.permission.as_str()
        )
    }
}

/// Issue #493: 各 tool が呼ぶ単一の権限チェック関数。
///
/// builtin role の hardcoded 権限テーブルだけを参照する (renderer の summary は信頼しない)。
/// 動的 role や未知 role は常に `Err(PermissionError)` を返す。
pub(in crate::team_hub) fn check_permission(role: &str, perm: Permission) -> Result<(), PermissionError> {
    if builtin_role_permission(role, perm) {
        Ok(())
    } else {
        Err(PermissionError {
            role: role.to_string(),
            permission: perm,
        })
    }
}

/// builtin role の hardcoded 権限テーブル。
/// renderer から差し替えられないため、ここで false のロールは絶対に該当 perm を持てない。
///
/// Issue #136: leader / hr 以外は全 false。動的 role (renderer が作った任意 id) も match
/// しないので全 false (= Hub レベルでは何もできない)。
/// Issue #342 Phase 3 (3.5): canViewDiagnostics は leader/hr のみ true。
/// 一般ワーカーが server_log_path 等を覗けると秘匿パス漏えいになるため default false。
fn builtin_role_permission(role: &str, perm: Permission) -> bool {
    use Permission::*;
    match (role, perm) {
        // Leader: 全権 (Recruit / Dismiss / AssignTasks / CreateRoleProfile / ViewDiagnostics)
        (
            "leader",
            Recruit | Dismiss | AssignTasks | CreateRoleProfile | ViewDiagnostics,
        ) => true,
        // HR: 採用 + タスク割振 + 動的ロール登録 + 診断 (Leader 代理として)。
        // Dismiss は意図的に持たない (Leader 専権)。
        ("hr", Recruit | AssignTasks | CreateRoleProfile | ViewDiagnostics) => true,
        // 一般ワーカー (planner / programmer / researcher / reviewer 等) と動的ロールはいずれも不可。
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leader_has_all_permissions() {
        for perm in [
            Permission::Recruit,
            Permission::Dismiss,
            Permission::AssignTasks,
            Permission::CreateRoleProfile,
            Permission::ViewDiagnostics,
        ] {
            assert!(
                check_permission("leader", perm).is_ok(),
                "leader should have {}",
                perm.as_str()
            );
        }
    }

    #[test]
    fn hr_has_recruit_assign_create_diagnostics_but_not_dismiss() {
        assert!(check_permission("hr", Permission::Recruit).is_ok());
        assert!(check_permission("hr", Permission::AssignTasks).is_ok());
        assert!(check_permission("hr", Permission::CreateRoleProfile).is_ok());
        assert!(check_permission("hr", Permission::ViewDiagnostics).is_ok());
        assert!(check_permission("hr", Permission::Dismiss).is_err());
    }

    #[test]
    fn worker_roles_have_nothing() {
        for role in ["planner", "programmer", "researcher", "reviewer"] {
            for perm in [
                Permission::Recruit,
                Permission::Dismiss,
                Permission::AssignTasks,
                Permission::CreateRoleProfile,
                Permission::ViewDiagnostics,
            ] {
                assert!(
                    check_permission(role, perm).is_err(),
                    "role '{role}' should not have {}",
                    perm.as_str()
                );
            }
        }
    }

    #[test]
    fn dynamic_or_unknown_roles_have_nothing() {
        for role in ["", "rogue", "vc-12345", "leader_v2", "leadeR"] {
            assert!(check_permission(role, Permission::Recruit).is_err());
            assert!(check_permission(role, Permission::Dismiss).is_err());
        }
    }

    /// Issue #737: `PermissionError` から各 tool が `ToolError::permission_denied` で構造化
    /// エラーを組み立てる経路 (旧 `into_message` による生 String 化の置き換え) を検証する。
    #[test]
    fn permission_error_role_drives_structured_tool_error() {
        use super::super::tools::error::ToolError;
        let err = check_permission("planner", Permission::Recruit).unwrap_err();
        let recruit = ToolError::permission_denied("recruit", &err.role, "recruit");
        assert_eq!(recruit.code, "recruit_permission_denied");
        assert_eq!(
            recruit.message,
            "permission denied: role 'planner' cannot recruit"
        );
        let ack = ToolError::permission_denied("ack_handoff", &err.role, "ack handoff");
        assert_eq!(ack.code, "ack_handoff_permission_denied");
        assert_eq!(
            ack.message,
            "permission denied: role 'planner' cannot ack handoff"
        );
    }
}

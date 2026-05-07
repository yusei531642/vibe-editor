//! Issue #494: `team_hub::protocol::permissions` の matrix integration test。
//!
//! Phase 2 (PR #501) で `Permission` enum + `check_permission()` に統一した権限チェックを、
//! 各 role × tool のフル組み合わせで網羅する。
//!
//! Issue #136 / Issue #342 Phase 3 (3.5) の SSOT 性 (= renderer の summary に依存せず Rust 側
//! hardcoded テーブルだけを参照) が崩れていないかをここで防衛する。matrix 化することで、
//! 将来の権限テーブル変更時に「どの role に何の権限を付与/剥奪したか」が diff から一目瞭然になる。

use crate::team_hub::protocol::permissions::{check_permission, Permission};

/// `Permission` enum の全 variant。新 variant を増やしたら必ずここを更新する。
const ALL_PERMISSIONS: &[Permission] = &[
    Permission::Recruit,
    Permission::Dismiss,
    Permission::AssignTasks,
    Permission::CreateRoleProfile,
    Permission::ViewDiagnostics,
];

/// 既存 builtin role 一覧。動的 role (`vc-...`) は別 test で扱う。
const BUILTIN_ROLES: &[&str] = &["leader", "hr"];

/// Issue #136: 一般ワーカーの代表。`builtin_role_permission` のテーブル外 = 全 false。
const WORKER_ROLES: &[&str] = &[
    "planner",
    "programmer",
    "researcher",
    "reviewer",
    "rust_engineer",
    "ui_fixer",
    "renderer_tester",
];

/// 動的 / 未知 role の代表。renderer が任意 ID で作るパターンを想定。
const DYNAMIC_OR_UNKNOWN_ROLES: &[&str] = &[
    "",
    "rogue",
    "vc-12345-uuid-style",
    "leader_v2",      // 表記揺れも builtin と一致しない
    "leadeR",         // case mismatch
    "Leader",         // case mismatch (capitalized)
    "phone-engineer", // 動的 role の典型
];

/// Leader は ALL_PERMISSIONS を保持する (Issue #136)。
#[test]
fn leader_has_full_permission_matrix() {
    for &perm in ALL_PERMISSIONS {
        assert!(
            check_permission("leader", perm).is_ok(),
            "leader must have {}",
            perm.as_str()
        );
    }
}

/// HR は Recruit / AssignTasks / CreateRoleProfile / ViewDiagnostics は持つが、
/// Dismiss は持たない (Leader 専権)。
#[test]
fn hr_lacks_only_dismiss() {
    assert!(check_permission("hr", Permission::Recruit).is_ok());
    assert!(check_permission("hr", Permission::AssignTasks).is_ok());
    assert!(check_permission("hr", Permission::CreateRoleProfile).is_ok());
    assert!(check_permission("hr", Permission::ViewDiagnostics).is_ok());
    let dismiss_err = check_permission("hr", Permission::Dismiss);
    assert!(
        dismiss_err.is_err(),
        "HR must NOT have Dismiss (Issue #136 / Leader-only)"
    );
}

/// 一般ワーカー role は ALL_PERMISSIONS のいずれも持たない。
#[test]
fn worker_roles_have_no_permissions() {
    for &role in WORKER_ROLES {
        for &perm in ALL_PERMISSIONS {
            assert!(
                check_permission(role, perm).is_err(),
                "worker '{role}' must not have {}",
                perm.as_str()
            );
        }
    }
}

/// 動的 / 未知 role / 表記揺れ も全 false。
/// Issue #136: renderer が作った任意 ID は Hub レベルで一切の権限を持たない。
#[test]
fn dynamic_and_unknown_roles_have_no_permissions() {
    for &role in DYNAMIC_OR_UNKNOWN_ROLES {
        for &perm in ALL_PERMISSIONS {
            assert!(
                check_permission(role, perm).is_err(),
                "dynamic/unknown '{role}' must not have {}",
                perm.as_str()
            );
        }
    }
}

/// `Permission::as_str` は legacy "canXxx" 文字列キーに固定。
/// renderer 側 `RoleProfileSummary.canRecruit` 等と表記が変わると
/// 両側の一致が静かに崩れるため、ここでスナップショットする。
#[test]
fn permission_as_str_keeps_camel_case_keys() {
    assert_eq!(Permission::Recruit.as_str(), "canRecruit");
    assert_eq!(Permission::Dismiss.as_str(), "canDismiss");
    assert_eq!(Permission::AssignTasks.as_str(), "canAssignTasks");
    assert_eq!(Permission::CreateRoleProfile.as_str(), "canCreateRoleProfile");
    assert_eq!(Permission::ViewDiagnostics.as_str(), "canViewDiagnostics");
}

/// builtin role × permission の **完全マトリクス**。
/// テーブル変更時に、どこの cell が flip したかを一目で見せるため列挙する。
#[test]
fn full_role_permission_matrix_snapshot() {
    fn allowed(role: &str, perm: Permission) -> bool {
        check_permission(role, perm).is_ok()
    }
    // (role, [Recruit, Dismiss, AssignTasks, CreateRoleProfile, ViewDiagnostics])
    let expected: &[(&str, [bool; 5])] = &[
        ("leader", [true, true, true, true, true]),
        ("hr", [true, false, true, true, true]),
        ("planner", [false; 5]),
        ("programmer", [false; 5]),
        ("researcher", [false; 5]),
        ("reviewer", [false; 5]),
        ("", [false; 5]),
        ("vc-anonymous", [false; 5]),
    ];
    for (role, expected_row) in expected {
        let actual_row = [
            allowed(role, Permission::Recruit),
            allowed(role, Permission::Dismiss),
            allowed(role, Permission::AssignTasks),
            allowed(role, Permission::CreateRoleProfile),
            allowed(role, Permission::ViewDiagnostics),
        ];
        assert_eq!(
            &actual_row, expected_row,
            "permission matrix mismatch for role={role}"
        );
    }
}

/// `BUILTIN_ROLES` と `WORKER_ROLES` の文字列が match arm の左辺と一致しているかの sanity check。
/// 例えば "Leader" (大文字) を builtin と勘違いして書いていないかをここで弾く。
#[test]
fn builtin_role_strings_match_lowercase_keys() {
    for &role in BUILTIN_ROLES {
        // builtin は何らかの permission を持つはず
        let has_any = ALL_PERMISSIONS
            .iter()
            .any(|&p| check_permission(role, p).is_ok());
        assert!(
            has_any,
            "BUILTIN_ROLES contains '{role}' but it has no permissions — likely a typo (case mismatch?)"
        );
    }
}

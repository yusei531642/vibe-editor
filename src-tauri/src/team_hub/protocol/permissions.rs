//! Issue #136 (Security): caller の role が要求された permission を持つか検証する。
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

use crate::team_hub::TeamHub;

pub(super) async fn caller_has_permission(
    _hub: &TeamHub,
    caller_role: &str,
    perm: &str,
) -> bool {
    builtin_role_permission(caller_role, perm)
}

/// builtin role の hardcoded 権限テーブル。
/// renderer から差し替えられないため、ここで false のロールは絶対に該当 perm を持てない。
pub(super) fn builtin_role_permission(role: &str, perm: &str) -> bool {
    match (role, perm) {
        // Leader: 全権
        ("leader", "canRecruit") => true,
        ("leader", "canDismiss") => true,
        ("leader", "canAssignTasks") => true,
        ("leader", "canCreateRoleProfile") => true,
        ("leader", "canViewDiagnostics") => true,
        // HR: 採用 + タスク割振 + 動的ロール登録 (Leader 代理として) + 診断
        ("hr", "canRecruit") => true,
        ("hr", "canAssignTasks") => true,
        ("hr", "canCreateRoleProfile") => true,
        ("hr", "canViewDiagnostics") => true,
        // 一般ワーカー (planner / programmer / researcher / reviewer 等) はいずれも不可。
        // 動的ロール (renderer が作った任意 id) も match しないので全 false。
        // Issue #342 Phase 3 (3.5): canViewDiagnostics は leader/hr のみ true。
        // 一般ワーカーが server_log_path 等を覗けると秘匿パス漏えいになるため default false。
        _ => false,
    }
}

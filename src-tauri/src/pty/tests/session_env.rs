//! Issue #738: `pty::session::env_allowlist::should_inherit_env` の integration test。
//!
//! 旧 `session.rs` 内 `env_strip_tests` をそのまま移設したもの。判定対象・期待値は不変。

use crate::pty::session::env_allowlist::should_inherit_env;

#[test]
fn blocks_internal_team_env_from_parent_process() {
    assert!(!should_inherit_env("VIBE_TEAM_SOCKET"));
    assert!(!should_inherit_env("VIBE_TEAM_TOKEN"));
    assert!(!should_inherit_env("VIBE_AGENT_ID"));
}

#[test]
fn blocks_common_secrets_by_default() {
    assert!(!should_inherit_env("AWS_SECRET_ACCESS_KEY"));
    assert!(!should_inherit_env("GITHUB_TOKEN"));
    assert!(!should_inherit_env("OPENAI_API_KEY"));
    assert!(!should_inherit_env("ANTHROPIC_API_KEY"));
    assert!(!should_inherit_env("DATABASE_URL"));
    assert!(!should_inherit_env("DOCKER_AUTH_CONFIG"));
    assert!(!should_inherit_env("SSH_AUTH_SOCK"));
}

#[test]
fn keeps_ordinary_env() {
    assert!(should_inherit_env("PATH"));
    assert!(should_inherit_env("HOME"));
    assert!(should_inherit_env("LANG"));
    assert!(should_inherit_env("USER"));
    assert!(should_inherit_env("TERM"));
    assert!(should_inherit_env("LC_ALL"));
    assert!(should_inherit_env("XDG_RUNTIME_DIR"));
}

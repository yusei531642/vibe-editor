//! Issue #738: `pty::session::env_allowlist::should_inherit_env` の integration test。
//!
//! 旧 `session.rs` 内 `env_strip_tests` をそのまま移設したもの。判定対象・期待値は不変。

use crate::pty::session::env_allowlist::{is_safe_renderer_env_key, should_inherit_env};

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

// ---------- Issue #889: renderer 由来 opts.env の allowlist ----------

#[test]
fn renderer_env_allows_vibe_team_keys() {
    // TeamHub 起動が壊れないこと (renderer が正規に渡す 5 キー)
    assert!(is_safe_renderer_env_key("VIBE_TEAM_SOCKET"));
    assert!(is_safe_renderer_env_key("VIBE_TEAM_TOKEN"));
    assert!(is_safe_renderer_env_key("VIBE_TEAM_ID"));
    assert!(is_safe_renderer_env_key("VIBE_TEAM_ROLE"));
    assert!(is_safe_renderer_env_key("VIBE_AGENT_ID"));
}

#[test]
fn renderer_env_blocks_code_injection_vectors() {
    assert!(!is_safe_renderer_env_key("NODE_OPTIONS"));
    assert!(!is_safe_renderer_env_key("LD_PRELOAD"));
    assert!(!is_safe_renderer_env_key("DYLD_INSERT_LIBRARIES"));
    assert!(!is_safe_renderer_env_key("BROWSER"));
    assert!(!is_safe_renderer_env_key("PYTHONSTARTUP"));
    assert!(!is_safe_renderer_env_key("PERL5OPT"));
    assert!(!is_safe_renderer_env_key("ELECTRON_RUN_AS_NODE"));
}

#[test]
fn renderer_env_blocks_case_variants() {
    // Windows の env 名は case 非依存なので小文字・混在も拒否されること
    assert!(!is_safe_renderer_env_key("node_options"));
    assert!(!is_safe_renderer_env_key("Node_Options"));
    assert!(!is_safe_renderer_env_key("ld_preload"));
    // VIBE_ prefix は case 揺れでも許可 (同じ理由で大文字化判定)
    assert!(is_safe_renderer_env_key("vibe_team_socket"));
}

#[test]
fn renderer_env_blocks_adjacent_prefixes() {
    // "VIBE_" で始まらない隣接名は拒否
    assert!(!is_safe_renderer_env_key("VIBEFAKE"));
    assert!(!is_safe_renderer_env_key("VIBE"));
    assert!(!is_safe_renderer_env_key(""));
}

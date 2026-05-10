//! Issue #624 (Security): IPC 入力検証の共通 helper。
//!
//! 旧来 `recruit_observed_while_hidden` / `team_history_save` / `team_presets_save` 等の各
//! IPC で id 検証 / 長さ上限 / charset 検査がバラバラに書かれており、抜け漏れが発生
//! しやすい状況だった。具体的には:
//!   - DoS: renderer から悪意ある巨大 JSON (100 MB 超) を team_history_save で送られると
//!     disk full まで反復可能だった (長さ上限なし)。
//!   - Log injection: team_id / agent_id に改行や ESC を埋め込まれた文字列が
//!     `tracing::info!(team_id = %team_id, ...)` を経由して log に流れ、改竄ログを混入できた。
//!
//! 本 module は以下を集約する:
//!   - `is_valid_id_segment` / `validate_id_segment`: `[A-Za-z0-9_-]{1,64}` の id 検証
//!   - `assert_max_size`: 永続化 payload (`MAX_PERSIST_PAYLOAD = 1 MiB`) の上限チェック
//!   - `sanitize_for_log`: tracing 出力前の制御文字 strip + 長さ clamp
//!   - `is_valid_terminal_id`: `is_valid_id_segment` の wrapper (既存 caller との互換)

use crate::commands::error::{CommandError, CommandResult};

/// Issue #624: ID segment (team_id / agent_id / preset_id 等) の最大長。
/// 既存 `is_valid_terminal_id` (`commands/terminal/command_validation.rs`) と揃える。
pub const MAX_ID_SEGMENT_LEN: usize = 64;

/// Issue #624: 永続化 payload (`team_history.json` / `team-presets.json` 等) の最大サイズ。
/// 1 MiB を超える renderer 由来 entry は `CommandError::Validation` で reject し、
/// disk full 系 DoS を抑止する。
pub const MAX_PERSIST_PAYLOAD: usize = 1024 * 1024;

/// `[A-Za-z0-9_-]{1,64}` 形式の id segment を許可する。改行 / 空白 / 制御文字 / shell
/// metachar / path separator (`/` `\`) を全て弾く。renderer 経由 string が log / path /
/// event name に乗るときの共通フィルタ。
pub fn is_valid_id_segment(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= MAX_ID_SEGMENT_LEN
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// `is_valid_id_segment` を `Result` 化したもの。reject 時は `CommandError::Validation` で返す。
/// `name` は error message 用 (例: "team_id" / "agent_id" / "preset_id")。
pub fn validate_id_segment<'a>(name: &str, s: &'a str) -> CommandResult<&'a str> {
    if is_valid_id_segment(s) {
        Ok(s)
    } else {
        Err(CommandError::validation(format!(
            "invalid {name}: must match [A-Za-z0-9_-]{{1,{MAX_ID_SEGMENT_LEN}}}"
        )))
    }
}

/// payload size が `max` 以内であることを assert。超過時は `CommandError::Validation`。
/// renderer から悪意ある巨大 JSON で disk を埋める DoS を防ぐ目的。
pub fn assert_max_size(payload_size: usize, max: usize) -> CommandResult<()> {
    if payload_size > max {
        return Err(CommandError::validation(format!(
            "payload too large: {payload_size} > {max} bytes"
        )));
    }
    Ok(())
}

/// 制御文字 (改行 / ESC / NUL / DEL 等) を除去し、`max_len` 文字で truncate する。
/// `tracing::info!(team_id = %sanitize_for_log(&team_id, 64), ...)` のように log 出力前に
/// 必ず通すことで、log injection (改行で偽 log 行を捏造) を防ぐ。
pub fn sanitize_for_log(s: &str, max_len: usize) -> String {
    s.chars()
        .filter(|c| !c.is_control())
        .take(max_len)
        .collect()
}

/// Issue #624: terminal id の検証 helper。`is_valid_id_segment` の thin wrapper として
/// 既存 caller (`commands::terminal::command_validation::is_valid_terminal_id`) と同じ
/// 規約 (`[A-Za-z0-9_-]{1,64}`) を維持する。
pub fn is_valid_terminal_id(s: &str) -> bool {
    is_valid_id_segment(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_segment_accepts_alnum_dash_underscore() {
        assert!(is_valid_id_segment("a"));
        assert!(is_valid_id_segment("abc_123-XYZ"));
        assert!(is_valid_id_segment("0"));
        assert!(is_valid_id_segment("term-1761800000000-abcd1234"));
        let s = "x".repeat(MAX_ID_SEGMENT_LEN);
        assert!(is_valid_id_segment(&s));
    }

    #[test]
    fn id_segment_rejects_empty_overlong_and_unsafe_chars() {
        assert!(!is_valid_id_segment(""));
        let s = "x".repeat(MAX_ID_SEGMENT_LEN + 1);
        assert!(!is_valid_id_segment(&s));
        // 制御文字 / 空白 / path sep / shell meta は全て不可
        assert!(!is_valid_id_segment("foo bar"));
        assert!(!is_valid_id_segment("foo\nbar"));
        assert!(!is_valid_id_segment("foo\tbar"));
        assert!(!is_valid_id_segment("foo/bar"));
        assert!(!is_valid_id_segment("foo\\bar"));
        assert!(!is_valid_id_segment("foo\x00bar"));
        assert!(!is_valid_id_segment("foo;rm -rf"));
        assert!(!is_valid_id_segment("foo$bar"));
    }

    #[test]
    fn validate_id_segment_returns_validation_error_on_bad_input() {
        let err =
            validate_id_segment("team_id", "evil\nINFO impersonated_log_line").unwrap_err();
        let msg = format!("{err}");
        assert!(
            msg.contains("invalid team_id"),
            "expected 'invalid team_id' in error: {msg}"
        );
    }

    #[test]
    fn validate_id_segment_returns_input_when_ok() {
        let ok = validate_id_segment("agent_id", "agent-001").unwrap();
        assert_eq!(ok, "agent-001");
    }

    #[test]
    fn assert_max_size_enforces_limit() {
        assert!(assert_max_size(0, 100).is_ok());
        assert!(assert_max_size(100, 100).is_ok());
        assert!(assert_max_size(101, 100).is_err());
    }

    /// Issue #624: 1 MiB 超 entry は team_history_save 等で reject される DoS 防御 test。
    #[test]
    fn assert_max_size_at_persist_payload_limit() {
        assert!(assert_max_size(MAX_PERSIST_PAYLOAD, MAX_PERSIST_PAYLOAD).is_ok());
        assert!(assert_max_size(MAX_PERSIST_PAYLOAD + 1, MAX_PERSIST_PAYLOAD).is_err());
    }

    #[test]
    fn sanitize_for_log_strips_control_chars_and_truncates() {
        assert_eq!(sanitize_for_log("hello\nworld\x07", 100), "helloworld");
        assert_eq!(sanitize_for_log("hello\x1b[2Jworld", 100), "hello[2Jworld");
        assert_eq!(sanitize_for_log("xxxxxxxx", 4), "xxxx");
    }

    /// `is_valid_terminal_id` が `is_valid_id_segment` と同じ判定を返す (二重定義の解消)。
    #[test]
    fn is_valid_terminal_id_is_same_as_id_segment() {
        for sample in [
            "550e8400-e29b-41d4-a716-446655440000",
            "abc_123",
            "",
            "x".repeat(65).as_str(),
            "evil\nattempt",
        ] {
            assert_eq!(is_valid_terminal_id(sample), is_valid_id_segment(sample));
        }
    }
}

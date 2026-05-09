// commands/terminal/command_validation.rs
//
// terminal.rs から move された command 検証 helper 群 (Phase 3 / Issue #373)。
// 純関数群 / PTY race とは無関係。

use std::collections::HashSet;

/// Issue #285: renderer から渡される terminal id を検証。
/// `terminal:data:{id}` 等のイベント名に乗るので、衝突や偽装防止のため
/// `[A-Za-z0-9_-]{1,64}` のみ許可する (UUID v4 は 36 chars で収まる)。
pub fn is_valid_terminal_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Issue #607: Claude `--resume <id>` に渡す session id を検証する (defense-in-depth)。
///
/// `resumeSessionId` は通常 `~/.claude/projects/<encoded>/<id>.jsonl` の file_stem や
/// renderer の zustand persist (`team-history.json`) 由来で、信頼境界の外にある。
/// `-` 始まりの文字列や shell metachar / 改行を埋められると `--resume <id>` の argv
/// が引数注入や parse 破壊を起こすため、Rust 側で `^[A-Za-z0-9_-]{8,64}$` に絞る。
///
/// UUID v4 (36 文字, ハイフン含む) を最低限通すよう下限は 8 文字、Claude CLI 側の
/// id 形式が将来変わる可能性を考慮して上限は 64 文字に緩めている。
pub fn is_valid_resume_session_id(s: &str) -> bool {
    let len = s.len();
    (8..=64).contains(&len)
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn command_basename(command: &str) -> String {
    let lower = command.trim().to_ascii_lowercase().replace('\\', "/");
    std::path::Path::new(&lower)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(lower.as_str())
        .to_string()
}

fn split_command_line(input: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut chars = input.trim().chars().peekable();

    while let Some(ch) = chars.next() {
        match ch {
            '"' | '\'' => {
                if quote == Some(ch) {
                    quote = None;
                } else if quote.is_none() {
                    quote = Some(ch);
                } else {
                    current.push(ch);
                }
            }
            '\\' => {
                let next = chars.peek().copied();
                if quote.is_some() && next == quote {
                    current.push(chars.next().unwrap_or(ch));
                } else if quote.is_none() && matches!(next, Some('"') | Some('\'')) {
                    current.push(chars.next().unwrap_or(ch));
                } else {
                    current.push(ch);
                }
            }
            c if c.is_whitespace() && quote.is_none() => {
                if !current.is_empty() {
                    parts.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }

    if !current.is_empty() {
        parts.push(current);
    }
    parts
}

pub fn normalize_terminal_command(
    command: Option<String>,
    args: Option<Vec<String>>,
) -> (String, Vec<String>) {
    let mut existing_args = args.unwrap_or_default();
    let raw = command
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("claude");
    let mut parts = split_command_line(raw);
    if parts.is_empty() {
        return ("claude".to_string(), existing_args);
    }
    let cmd = parts.remove(0);
    parts.append(&mut existing_args);
    (cmd, parts)
}

pub fn configured_terminal_commands() -> HashSet<String> {
    let mut out = HashSet::new();
    let path = crate::util::config_paths::settings_path();
    let Ok(bytes) = std::fs::read(path) else {
        return out;
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return out;
    };
    let mut push = |raw: Option<&str>| {
        if let Some(cmd) = raw.map(str::trim).filter(|s| !s.is_empty()) {
            out.insert(cmd.to_ascii_lowercase());
            if let Some(program) = split_command_line(cmd).first() {
                out.insert(program.to_ascii_lowercase());
            }
        }
    };
    push(value.get("claudeCommand").and_then(|v| v.as_str()));
    push(value.get("codexCommand").and_then(|v| v.as_str()));
    if let Some(custom) = value.get("customAgents").and_then(|v| v.as_array()) {
        for agent in custom {
            push(agent.get("command").and_then(|v| v.as_str()));
        }
    }
    out
}

/// Issue #201:
/// renderer 由来の任意コマンド実行を避けるため、起動できるバイナリを
/// 1. 組み込み allowlist (Claude / Codex / 代表的な対話シェル)
/// 2. ユーザーが settings.json に保存した既知の command
///
/// に限定する。
pub fn is_allowed_terminal_command(command: &str) -> bool {
    const SAFE_BASENAMES: &[&str] = &[
        "claude",
        "codex",
        "bash",
        "sh",
        "zsh",
        "fish",
        "pwsh",
        "powershell",
        "cmd",
        "nu",
    ];
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return false;
    }
    let basename = command_basename(trimmed);
    if SAFE_BASENAMES.contains(&basename.as_str()) {
        return true;
    }
    configured_terminal_commands().contains(&trimmed.to_ascii_lowercase())
}

pub fn reject_immediate_exec_args(command: &str, args: &[String]) -> Option<&'static str> {
    let basename = command_basename(command);
    let lower_args: Vec<String> = args.iter().map(|a| a.trim().to_ascii_lowercase()).collect();
    let has_any = |candidates: &[&str]| {
        lower_args
            .iter()
            .any(|arg| candidates.contains(&arg.as_str()))
    };
    match basename.as_str() {
        "bash" | "sh" | "zsh" | "fish" => {
            if has_any(&["-c", "-lc"]) {
                Some("shell immediate-exec flags (-c / -lc) are blocked")
            } else {
                None
            }
        }
        "pwsh" | "powershell" => {
            if has_any(&["-c", "-command", "/command", "-encodedcommand", "-file"]) {
                Some("PowerShell immediate-exec flags (-Command / -EncodedCommand / -File) are blocked")
            } else {
                None
            }
        }
        "cmd" => {
            if has_any(&["/c", "/k"]) {
                Some("cmd immediate-exec flags (/c /k) are blocked")
            } else {
                None
            }
        }
        "nu" => {
            if has_any(&["-c", "--commands"]) {
                Some("nushell immediate-exec flags (-c / --commands) are blocked")
            } else {
                None
            }
        }
        _ => None,
    }
}

/// command が codex 系か判定 (パス形式や *.exe も拾う)
///
/// Path::new は OS のセパレータしか認識しない (Linux では `\` が単なる文字扱い) ので、
/// Windows-style な `C:\tools\codex.exe` も Linux CI で正しく判定できるよう、
/// 先に `/` `\` 双方をスラッシュに正規化してから basename を取り出す。
pub fn is_codex_command(command: &str) -> bool {
    let lower = command.to_ascii_lowercase().replace('\\', "/");
    let basename = std::path::Path::new(&lower)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(&lower);
    basename == "codex" || basename.ends_with("-codex") || basename.starts_with("codex-")
}

#[cfg(test)]
mod terminal_id_validation_tests {
    use super::is_valid_terminal_id;

    #[test]
    fn accepts_uuid_v4() {
        assert!(is_valid_terminal_id("550e8400-e29b-41d4-a716-446655440000"));
    }

    #[test]
    fn accepts_alphanumeric_and_separators() {
        assert!(is_valid_terminal_id("abc_123-XYZ"));
        assert!(is_valid_terminal_id("term-1761800000000-abcd1234"));
        assert!(is_valid_terminal_id("a"));
        assert!(is_valid_terminal_id("0"));
    }

    #[test]
    fn accepts_max_length() {
        let s = "a".repeat(64);
        assert!(is_valid_terminal_id(&s));
    }

    #[test]
    fn rejects_empty() {
        assert!(!is_valid_terminal_id(""));
    }

    #[test]
    fn rejects_overlength() {
        let s = "a".repeat(65);
        assert!(!is_valid_terminal_id(&s));
    }

    #[test]
    fn rejects_path_traversal() {
        assert!(!is_valid_terminal_id("../etc/passwd"));
        assert!(!is_valid_terminal_id("./id"));
    }

    #[test]
    fn rejects_event_name_injection() {
        // ":" を入れると `terminal:data:foo:bar` のように Tauri event 名前空間を細工される懸念
        assert!(!is_valid_terminal_id("foo:bar"));
        assert!(!is_valid_terminal_id("data:malicious"));
    }

    #[test]
    fn rejects_whitespace_and_shell_metachars() {
        assert!(!is_valid_terminal_id("abc def"));
        assert!(!is_valid_terminal_id("abc;rm"));
        assert!(!is_valid_terminal_id("abc|true"));
        assert!(!is_valid_terminal_id("abc$VAR"));
        assert!(!is_valid_terminal_id("abc`whoami`"));
    }

    #[test]
    fn rejects_non_ascii() {
        assert!(!is_valid_terminal_id("日本語"));
        assert!(!is_valid_terminal_id("café"));
    }
}

#[cfg(test)]
mod resume_session_id_validation_tests {
    use super::is_valid_resume_session_id;

    #[test]
    fn accepts_uuid_v4() {
        assert!(is_valid_resume_session_id("550e8400-e29b-41d4-a716-446655440000"));
    }

    #[test]
    fn accepts_alphanumeric_and_separators() {
        assert!(is_valid_resume_session_id("abc_123-XYZ_456"));
        assert!(is_valid_resume_session_id("session-1761800000000-abcd1234"));
    }

    #[test]
    fn accepts_min_and_max_length() {
        assert!(is_valid_resume_session_id(&"a".repeat(8)));
        assert!(is_valid_resume_session_id(&"a".repeat(64)));
    }

    #[test]
    fn rejects_too_short() {
        assert!(!is_valid_resume_session_id(""));
        assert!(!is_valid_resume_session_id("a"));
        assert!(!is_valid_resume_session_id(&"a".repeat(7)));
    }

    #[test]
    fn rejects_too_long() {
        assert!(!is_valid_resume_session_id(&"a".repeat(65)));
        assert!(!is_valid_resume_session_id(&"a".repeat(256)));
    }

    #[test]
    fn rejects_argument_injection_via_leading_dash() {
        // `-` 始まりは UUID v4 (8-4-4-4-12) でも合法だが、`-` のみで始まる「フラグ風」は
        // charset 的には通る。これは Rust 側で `Command::arg("--resume").arg(&id)` の 2 要素
        // 分離で防御するので charset には含めて良いが、shell metachar は確実に弾く。
        assert!(!is_valid_resume_session_id("--print=/etc/passwd"));
        assert!(!is_valid_resume_session_id("-c rm -rf"));
    }

    #[test]
    fn rejects_shell_metachars_and_whitespace() {
        assert!(!is_valid_resume_session_id("abc;rm -rf"));
        assert!(!is_valid_resume_session_id("abc|true123"));
        assert!(!is_valid_resume_session_id("abc$VAR_test"));
        assert!(!is_valid_resume_session_id("abc`whoami`"));
        assert!(!is_valid_resume_session_id("abc def_long"));
        assert!(!is_valid_resume_session_id("abc\nrm_rf"));
        assert!(!is_valid_resume_session_id("abc\rm_rf12"));
        assert!(!is_valid_resume_session_id("abc\tdef_long"));
    }

    #[test]
    fn rejects_path_traversal() {
        assert!(!is_valid_resume_session_id("../etc/passwd"));
        assert!(!is_valid_resume_session_id("./session"));
        assert!(!is_valid_resume_session_id("/abs/path/id"));
    }

    #[test]
    fn rejects_non_ascii() {
        assert!(!is_valid_resume_session_id("セッション-12345"));
        assert!(!is_valid_resume_session_id("café-session-id"));
    }
}

#[cfg(test)]
mod codex_command_tests {
    use super::is_codex_command;

    #[test]
    fn detects_basic_codex() {
        assert!(is_codex_command("codex"));
        assert!(is_codex_command("CODEX"));
        assert!(is_codex_command("/usr/local/bin/codex"));
        assert!(is_codex_command(r"C:\tools\codex.exe"));
    }

    #[test]
    fn rejects_non_codex() {
        assert!(!is_codex_command("claude"));
        assert!(!is_codex_command("bash"));
        assert!(!is_codex_command(""));
    }
}

#[cfg(test)]
mod command_normalization_tests {
    use super::{normalize_terminal_command, reject_immediate_exec_args, split_command_line};

    #[test]
    fn splits_inline_codex_flags_from_command_field() {
        let (command, args) = normalize_terminal_command(
            Some("codex --dangerously-bypass-approvals-and-sandbox".to_string()),
            None,
        );

        assert_eq!(command, "codex");
        assert_eq!(args, vec!["--dangerously-bypass-approvals-and-sandbox"]);
    }

    #[test]
    fn inline_args_are_prepended_before_existing_args() {
        let (command, args) = normalize_terminal_command(
            Some("codex --dangerously-bypass-approvals-and-sandbox".to_string()),
            Some(vec![
                "-c".to_string(),
                "disable_paste_burst=true".to_string(),
                "--config".to_string(),
                r"model_instructions_file=C:\Users\zooyo\.vibe-editor\codex-instructions\instr.md"
                    .to_string(),
            ]),
        );

        assert_eq!(command, "codex");
        assert_eq!(
            args,
            vec![
                "--dangerously-bypass-approvals-and-sandbox",
                "-c",
                "disable_paste_burst=true",
                "--config",
                r"model_instructions_file=C:\Users\zooyo\.vibe-editor\codex-instructions\instr.md",
            ]
        );
    }

    #[test]
    fn splits_claude_inline_command_args_with_system_prompt() {
        let prompt = "あなたはチーム「Leader」のLeader。\n最初の指示が来るまで待機する。";
        let (command, args) = normalize_terminal_command(
            Some(format!(
                r#"claude --dangerously-skip-permissions --chrome --append-system-prompt "{prompt}""#
            )),
            None,
        );

        assert_eq!(command, "claude");
        assert_eq!(
            args,
            vec![
                "--dangerously-skip-permissions",
                "--chrome",
                "--append-system-prompt",
                prompt,
            ]
        );
    }

    #[test]
    fn strips_quotes_around_windows_executable_path() {
        let (command, args) = normalize_terminal_command(
            Some(r#""C:\Program Files\Codex\codex.exe" --foo "bar baz""#.to_string()),
            None,
        );

        assert_eq!(command, r"C:\Program Files\Codex\codex.exe");
        assert_eq!(args, vec!["--foo", "bar baz"]);
    }

    #[test]
    fn defaults_to_claude_when_command_is_blank() {
        let (command, args) =
            normalize_terminal_command(Some("   ".to_string()), Some(vec!["--resume".into()]));

        assert_eq!(command, "claude");
        assert_eq!(args, vec!["--resume"]);
    }

    #[test]
    fn split_preserves_windows_backslashes() {
        assert_eq!(
            split_command_line(
                r#"codex --config model_instructions_file=C:\Users\zooyo\.vibe-editor\instr.md"#
            ),
            vec![
                "codex",
                "--config",
                r"model_instructions_file=C:\Users\zooyo\.vibe-editor\instr.md",
            ]
        );
    }

    #[test]
    fn immediate_exec_rejection_runs_after_normalization() {
        let (command, args) =
            normalize_terminal_command(Some("cmd /c echo unsafe".to_string()), None);

        assert_eq!(command, "cmd");
        assert_eq!(
            reject_immediate_exec_args(&command, &args),
            Some("cmd immediate-exec flags (/c /k) are blocked")
        );
    }
}

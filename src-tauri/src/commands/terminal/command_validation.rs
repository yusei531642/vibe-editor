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
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn command_basename(command: &str) -> String {
    let lower = command.trim().to_ascii_lowercase().replace('\\', "/");
    std::path::Path::new(&lower)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(lower.as_str())
        .to_string()
}

pub fn configured_terminal_commands() -> HashSet<String> {
    let mut out = HashSet::new();
    let Some(home) = dirs::home_dir() else {
        return out;
    };
    let path = home.join(".vibe-editor").join("settings.json");
    let Ok(bytes) = std::fs::read(path) else {
        return out;
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return out;
    };
    let mut push = |raw: Option<&str>| {
        if let Some(cmd) = raw.map(str::trim).filter(|s| !s.is_empty()) {
            out.insert(cmd.to_ascii_lowercase());
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
    let has_any = |candidates: &[&str]| lower_args.iter().any(|arg| candidates.contains(&arg.as_str()));
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

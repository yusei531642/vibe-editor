// commands/terminal/command_validation.rs
//
// terminal.rs から move された command 検証 helper 群 (Phase 3 / Issue #373)。
// 純関数群 / PTY race とは無関係。

use std::collections::HashSet;

/// Issue #285: renderer から渡される terminal id を検証。
/// `terminal:data:{id}` 等のイベント名に乗るので、衝突や偽装防止のため
/// `[A-Za-z0-9_-]{1,64}` のみ許可する (UUID v4 は 36 chars で収まる)。
///
/// Issue #624: validation 規約は `commands::validation::is_valid_id_segment` に集約済み。
/// 本関数は既存 caller との互換維持のための薄い wrapper として残す (規約の二重定義を解消)。
pub fn is_valid_terminal_id(s: &str) -> bool {
    crate::commands::validation::is_valid_terminal_id(s)
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

/// Issue #618: `~/.vibe-editor/settings.json` から `terminalForceUtf8` を読み出す。
/// settings.json が無い / parse 失敗 / フィールド未定義のいずれの場合も `true` (default) を返す。
/// `terminal_create` 経路から spawn 直前にだけ呼ぶ想定 (1 spawn = 1 file read のオーバーヘッドのみ)。
pub fn settings_terminal_force_utf8() -> bool {
    let path = crate::util::config_paths::settings_path();
    let Ok(bytes) = std::fs::read(path) else {
        return true;
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return true;
    };
    value
        .get("terminalForceUtf8")
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

/// Issue #618: Windows ConPTY で起動するシェルが UTF-8 になるよう、最初に PTY 入力ストリームへ
/// 流す初期コマンドを返す (バイト列 + `\r` 終端で「Enter 押下」相当の確定送信になる)。
///
/// - cmd.exe (`cmd` / `cmd.exe`): `chcp 65001 > nul\r`
///   `> nul` で active code page 切替の echo を抑止する (banner 直後の余分な行を avoid)。
/// - PowerShell (`pwsh` / `powershell`): `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); chcp 65001 > $null\r`
///   PowerShell は `[Console]::OutputEncoding` を別途 UTF-8 にしないと .NET 出力 (Write-Host 等) が
///   UTF-8 にならないので、`chcp` と同時に設定する。
/// - その他 (bash / sh / zsh / fish / nu / claude / codex / 解決前の任意 path): `None`
///   modern な POSIX シェルや WSL は既定で UTF-8。Claude / Codex CLI は ConPTY 経由でも文字列
///   出力を内部で UTF-8 で書き出す (chcp inject すると CLI 側の prompt が壊れる懸念がある)。
///
/// 非 Windows OS ではそもそも CP932 問題が無いので、呼び出し側で `cfg!(windows)` でガードする想定。
pub fn windows_utf8_init_command(command: &str) -> Option<&'static [u8]> {
    let basename = command_basename(command);
    match basename.as_str() {
        "cmd" => Some(b"chcp 65001 > nul\r"),
        "powershell" | "pwsh" => Some(
            b"[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); chcp 65001 > $null\r",
        ),
        _ => None,
    }
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

/// Issue #743 / #788: Claude / Codex の承認スキップ・サンドボックス回避フラグの扱い。
///
/// 以下フラグは外部 CLI を承認・サンドボックス無しで起動できてしまうため、renderer
/// から **動的に注入された** もの (prompt injection 等の経路) は spawn 前に拒否する。
///
/// 一方 vibe-editor は Claude Code / Codex 専用エディタであり、ユーザーが自分の
/// マシンの `~/.vibe-editor/settings.json` (`claudeArgs` / `codexArgs` /
/// `customAgents[].args`) に **明示的に書いた** フラグは信頼境界の内側にある正規の
/// opt-in なので許可する。`reject_danger_flags` には settings 由来の sanction 集合
/// ([`settings_sanctioned_danger_flags`]) を渡し、その集合に無いフラグだけを拒否する。
const DENY_FLAGS: &[&str] = &[
    "--dangerously-skip-permissions",
    "--dangerously-bypass-approvals-and-sandbox",
];

/// token 先頭の dash 類 (ASCII `-` / Unicode ダッシュ) を全て剥がした stem が
/// `DENY_FLAGS` のいずれかと一致すれば、canonical な `--` 形のフラグを返す。
///
/// renderer 側 `parse-args.ts` の `normalizeLeadingDashes` (Issue #449) と同様に、
/// autocorrect 由来の en dash や単一 `-` 等の dash 表記揺れを吸収する。これにより
/// settings.json に表記揺れで保存された値も正しく sanction 集合へ取り込める。
fn canonical_danger_flag(token: &str) -> Option<&'static str> {
    let stem = token.trim().trim_start_matches(|c: char| {
        c == '-'
            || matches!(
                c,
                '\u{2010}'..='\u{2015}' | '\u{2212}' | '\u{FE58}' | '\u{FE63}' | '\u{FF0D}'
            )
    });
    if stem.is_empty() {
        return None;
    }
    DENY_FLAGS
        .iter()
        .copied()
        .find(|flag| flag.trim_start_matches('-') == stem)
}

/// Issue #788: `~/.vibe-editor/settings.json` の `claudeArgs` / `codexArgs` /
/// `customAgents[].args` にユーザーが明示的に書いた危険フラグを canonical 形で集める。
/// ここに含まれるフラグは「ユーザー自身が opt-in したもの」として spawn を許可する。
///
/// settings.json が無い / parse 失敗の場合は空集合 (= 何も sanction しない) を返す。
/// `terminal_create` / spawn 境界から spawn 直前にだけ呼ぶ想定 (1 spawn = 1 file read)。
pub fn settings_sanctioned_danger_flags() -> HashSet<String> {
    let mut out = HashSet::new();
    let path = crate::util::config_paths::settings_path();
    let Ok(bytes) = std::fs::read(path) else {
        return out;
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return out;
    };
    let mut collect = |raw: Option<&str>| {
        if let Some(s) = raw {
            for token in split_command_line(s) {
                if let Some(flag) = canonical_danger_flag(&token) {
                    out.insert(flag.to_string());
                }
            }
        }
    };
    collect(value.get("claudeArgs").and_then(|v| v.as_str()));
    collect(value.get("codexArgs").and_then(|v| v.as_str()));
    if let Some(custom) = value.get("customAgents").and_then(|v| v.as_array()) {
        for agent in custom {
            collect(agent.get("args").and_then(|v| v.as_str()));
        }
    }
    out
}

/// `args` に含まれる危険フラグ (`DENY_FLAGS`) のうち、`sanctioned`
/// (= ユーザーが settings.json に明示した集合 / [`settings_sanctioned_danger_flags`])
/// に **無い** ものを 1 つでも見つけたら error 文を返す。sanction 済みフラグは許可する。
pub fn reject_danger_flags(args: &[String], sanctioned: &HashSet<String>) -> Option<String> {
    for arg in args {
        let flag = arg.trim();
        if DENY_FLAGS.contains(&flag) && !sanctioned.contains(flag) {
            return Some(format!("dangerous flag is not allowed: {flag}"));
        }
    }
    None
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
mod windows_utf8_init_command_tests {
    use super::windows_utf8_init_command;

    #[test]
    fn cmd_returns_chcp_only() {
        let init = windows_utf8_init_command("cmd").expect("cmd should have init");
        assert_eq!(init, b"chcp 65001 > nul\r");
    }

    #[test]
    fn cmd_exe_path_returns_chcp() {
        let init = windows_utf8_init_command(r"C:\Windows\System32\cmd.exe").expect("cmd.exe");
        assert_eq!(init, b"chcp 65001 > nul\r");
    }

    #[test]
    fn cmd_uppercase_returns_chcp() {
        let init = windows_utf8_init_command("CMD.EXE").expect("CMD.EXE");
        assert_eq!(init, b"chcp 65001 > nul\r");
    }

    #[test]
    fn powershell_returns_combined_init() {
        let init = windows_utf8_init_command("powershell").expect("powershell");
        let s = std::str::from_utf8(init).unwrap();
        assert!(s.starts_with("[Console]::OutputEncoding ="));
        assert!(s.contains("UTF8Encoding"));
        assert!(s.contains("chcp 65001"));
        assert!(s.contains("> $null"));
        assert!(s.ends_with("\r"));
    }

    #[test]
    fn pwsh_returns_combined_init() {
        let init = windows_utf8_init_command("pwsh").expect("pwsh");
        let s = std::str::from_utf8(init).unwrap();
        assert!(s.contains("[Console]::OutputEncoding"));
        assert!(s.contains("chcp 65001"));
    }

    #[test]
    fn pwsh_full_path_returns_init() {
        let init =
            windows_utf8_init_command(r"C:\Program Files\PowerShell\7\pwsh.exe").expect("pwsh.exe");
        let s = std::str::from_utf8(init).unwrap();
        assert!(s.contains("[Console]::OutputEncoding"));
    }

    #[test]
    fn bash_returns_none() {
        assert!(windows_utf8_init_command("bash").is_none());
        assert!(windows_utf8_init_command("/usr/bin/bash").is_none());
    }

    #[test]
    fn other_posix_shells_return_none() {
        assert!(windows_utf8_init_command("sh").is_none());
        assert!(windows_utf8_init_command("zsh").is_none());
        assert!(windows_utf8_init_command("fish").is_none());
        assert!(windows_utf8_init_command("nu").is_none());
    }

    #[test]
    fn claude_and_codex_return_none() {
        // Claude / Codex は内部で UTF-8 出力する CLI なので chcp inject しない。
        // CLI の prompt / banner と衝突する懸念の方が大きい。
        assert!(windows_utf8_init_command("claude").is_none());
        assert!(windows_utf8_init_command("codex").is_none());
        assert!(windows_utf8_init_command(r"C:\tools\codex.exe").is_none());
    }

    #[test]
    fn empty_or_unknown_returns_none() {
        assert!(windows_utf8_init_command("").is_none());
        assert!(windows_utf8_init_command("nonexistent-shell").is_none());
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
    use super::{
        canonical_danger_flag, normalize_terminal_command, reject_danger_flags,
        reject_immediate_exec_args, split_command_line,
    };
    use std::collections::HashSet;

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

    // Issue #743: --dangerously-* フラグの拒否
    #[test]
    fn rejects_claude_skip_permissions_flag() {
        let args = vec!["--dangerously-skip-permissions".to_string()];
        assert_eq!(
            reject_danger_flags(&args, &HashSet::new()),
            Some("dangerous flag is not allowed: --dangerously-skip-permissions".to_string())
        );
    }

    #[test]
    fn rejects_codex_bypass_approvals_and_sandbox_flag() {
        let args = vec!["--dangerously-bypass-approvals-and-sandbox".to_string()];
        assert_eq!(
            reject_danger_flags(&args, &HashSet::new()),
            Some(
                "dangerous flag is not allowed: --dangerously-bypass-approvals-and-sandbox"
                    .to_string()
            )
        );
    }

    #[test]
    fn rejects_dangerous_flag_when_buried_in_args() {
        let args = vec![
            "--resume".to_string(),
            "abc".to_string(),
            "--dangerously-skip-permissions".to_string(),
            "--append-system-prompt".to_string(),
            "hi".to_string(),
        ];
        assert!(reject_danger_flags(&args, &HashSet::new()).is_some());
    }

    #[test]
    fn rejects_dangerous_flag_via_settings_inline_command() {
        // settings.json の claude_args / codex_args が inline command field に
        // 入っているケースも normalize 後に args へ展開されるため拒否されること
        let (command, args) = normalize_terminal_command(
            Some("claude --dangerously-skip-permissions --resume abc".to_string()),
            None,
        );

        assert_eq!(command, "claude");
        assert!(reject_danger_flags(&args, &HashSet::new()).is_some());
    }

    #[test]
    fn rejects_dangerous_flag_via_separate_args_array() {
        // claude_args が args フィールド (Vec<String>) として渡されるケース
        let (command, args) = normalize_terminal_command(
            Some("codex".to_string()),
            Some(vec![
                "--dangerously-bypass-approvals-and-sandbox".to_string(),
                "--config".to_string(),
                "model=foo".to_string(),
            ]),
        );

        assert_eq!(command, "codex");
        assert!(reject_danger_flags(&args, &HashSet::new()).is_some());
    }

    #[test]
    fn passes_clean_args_unchanged() {
        let args = vec![
            "--resume".to_string(),
            "abc".to_string(),
            "--append-system-prompt".to_string(),
            "hi".to_string(),
        ];
        assert_eq!(reject_danger_flags(&args, &HashSet::new()), None);
    }

    #[test]
    fn passes_empty_args() {
        assert_eq!(reject_danger_flags(&[], &HashSet::new()), None);
    }

    #[test]
    fn does_not_match_substring_of_dangerous_flag() {
        // 例えば --dangerously-skip-permissions-x のような未来の擬似フラグは別物として扱う
        let args = vec!["--dangerously-skip-permissions-extra".to_string()];
        assert_eq!(reject_danger_flags(&args, &HashSet::new()), None);
    }

    // Issue #788: settings.json でユーザーが明示した危険フラグは許可する
    #[test]
    fn allows_sanctioned_flag_from_user_settings() {
        // ユーザーが settings.json (claudeArgs 等) に明示したフラグは sanction 集合に
        // 入るため許可される (vibe-editor の autonomous 起動の正規ユース)。
        let args = vec!["--dangerously-skip-permissions".to_string()];
        let sanctioned: HashSet<String> = ["--dangerously-skip-permissions".to_string()]
            .into_iter()
            .collect();
        assert_eq!(reject_danger_flags(&args, &sanctioned), None);
    }

    #[test]
    fn rejects_unsanctioned_flag_even_when_other_flag_is_sanctioned() {
        // skip-permissions だけ sanction されていても、settings に無い
        // bypass-approvals フラグ (renderer 動的注入相当) は別物として拒否する。
        let args = vec!["--dangerously-bypass-approvals-and-sandbox".to_string()];
        let sanctioned: HashSet<String> = ["--dangerously-skip-permissions".to_string()]
            .into_iter()
            .collect();
        assert!(reject_danger_flags(&args, &sanctioned).is_some());
    }

    #[test]
    fn canonical_danger_flag_normalizes_dash_variants() {
        // ASCII `--` / 単一 `-` / en dash いずれの dash 表記でも canonical 形へ解決する。
        assert_eq!(
            canonical_danger_flag("--dangerously-skip-permissions"),
            Some("--dangerously-skip-permissions")
        );
        assert_eq!(
            canonical_danger_flag("-dangerously-skip-permissions"),
            Some("--dangerously-skip-permissions")
        );
        assert_eq!(
            canonical_danger_flag("\u{2013}dangerously-bypass-approvals-and-sandbox"),
            Some("--dangerously-bypass-approvals-and-sandbox")
        );
    }

    #[test]
    fn canonical_danger_flag_ignores_non_danger_tokens() {
        assert_eq!(canonical_danger_flag("--resume"), None);
        assert_eq!(
            canonical_danger_flag("--dangerously-skip-permissions-extra"),
            None
        );
        assert_eq!(canonical_danger_flag(""), None);
        assert_eq!(canonical_danger_flag("--"), None);
    }
}

// commands/terminal/shell_policy_tests.rs
//
// Issue #933: shell_policy.rs (対話モード限定 allowlist 契約) のテスト。
// 本体とファイルを分けているのはファイルサイズ ratchet (新規 500 行制限) の単位を
// 「ロジック」と「テスト」で独立に保つため。`#[path]` で shell_policy.rs から mod 宣言される。

use super::*;

fn no_reg() -> HashSet<Vec<String>> {
    HashSet::new()
}

fn rejected(command: &str, args: &[&str]) -> bool {
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    reject_non_interactive_shell_args(command, &args, &no_reg()).is_some()
}

#[test]
fn non_shell_commands_are_out_of_scope() {
    assert!(!rejected("claude", &["--resume", "abc"]));
    assert!(!rejected("codex", &["-c", "disable_paste_burst=true"]));
    assert!(!rejected(r"C:\tools\codex.exe", &["--config", "model=foo"]));
}

#[test]
fn bare_shell_launch_is_allowed() {
    for shell in super::SHELL_BASENAMES {
        assert!(!rejected(shell, &[]), "{shell} (no args) must be allowed");
    }
}

#[test]
fn posix_interactive_flags_are_allowed() {
    for arg in ["-i", "-l", "-il", "-li", "--login", "--norc", "--", "-"] {
        assert!(!rejected("bash", &[arg]), "bash {arg} must be allowed");
    }
    assert!(!rejected("zsh", &["-l", "-i"]));
    assert!(!rejected("sh", &["--posix"]));
}

// 旧 denylist (#890) で塞いでいた攻撃面が allowlist でも塞がり続けること
#[test]
fn posix_immediate_exec_is_still_rejected() {
    for arg in ["-c", "-lc", "-cl", "-cx", "-xc", "-ic", "--command=evil"] {
        assert!(rejected("bash", &[arg, "evil"]), "bash {arg} must be rejected");
    }
    for arg in ["--c", "--co", "--com", "--command", "--commands", "--com=evil"] {
        assert!(rejected("fish", &[arg]), "fish {arg} must be rejected");
    }
}

// Issue #933 の本丸: denylist が素通りさせていた positional スクリプト実行を塞ぐ
#[test]
fn posix_positional_script_is_rejected() {
    assert!(rejected("bash", &["/tmp/evil.sh"]));
    assert!(rejected("zsh", &["script.zsh"]));
    assert!(rejected("sh", &["-i", "/tmp/evil.sh"]));
}

// 未知フラグ (将来のシェル拡張・列挙漏れ相当) が既定で deny 側に倒れること
#[test]
fn posix_unknown_flags_are_rejected_by_default() {
    assert!(rejected("bash", &["--rcfile", "/tmp/payload"]));
    assert!(rejected("bash", &["-s"]));
    assert!(rejected("zsh", &["-y"]));
}

#[test]
fn fish_interactive_flags_are_allowed() {
    for arg in ["-i", "-l", "--login", "--interactive", "--private", "--no-config"] {
        assert!(!rejected("fish", &[arg]), "fish {arg} must be allowed");
    }
}

#[test]
fn powershell_interactive_flags_are_allowed() {
    assert!(!rejected("powershell", &["-NoLogo", "-NoProfile"]));
    assert!(!rejected("pwsh", &["-nop", "-NoExit"]));
    assert!(!rejected("pwsh", &["-ExecutionPolicy", "Bypass"]));
    assert!(!rejected("powershell", &["-ep:RemoteSigned"]));
    assert!(!rejected("powershell", &["-ep=bypass"]));
    assert!(!rejected("pwsh", &["-MTA"]));
}

#[test]
fn powershell_immediate_exec_is_still_rejected() {
    for arg in [
        "-c",
        "-co",
        "-command",
        "-e",
        "-ec",
        "-enc",
        "-encodedcommand",
        "-f",
        "-file",
        "-command:iex",
        "-com=iex",
        "/command",
    ] {
        assert!(
            rejected("powershell", &[arg, "payload"]),
            "powershell {arg} must be rejected"
        );
    }
    assert!(rejected(
        r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
        &["-e", "payload"]
    ));
}

#[test]
fn powershell_positional_and_unknown_flags_are_rejected() {
    // positional (スクリプトパス)
    assert!(rejected("pwsh", &["script.ps1"]));
    // -ExecutionPolicy の値が policy キーワードでない (スクリプトパス等) は拒否
    assert!(rejected("pwsh", &["-ep", "script.ps1"]));
    assert!(rejected("pwsh", &["-ExecutionPolicy"]));
    // 未知フラグ・対話契約外フラグは既定拒否
    assert!(rejected("powershell", &["-ConfigurationName", "x"]));
    assert!(rejected("powershell", &["-WindowStyle", "Hidden"]));
    // Unicode dash の表記揺れも stem 解決される
    assert!(rejected("pwsh", &["\u{2013}command", "iex"]));
}

#[test]
fn cmd_interactive_flags_are_allowed_and_exec_rejected() {
    assert!(!rejected("cmd", &["/q", "/d"]));
    assert!(!rejected("cmd", &["/V:ON"]));
    assert!(rejected("cmd", &["/c", "echo unsafe"]));
    assert!(rejected("cmd", &["/k", "evil"]));
    assert!(rejected("cmd", &["script.bat"]));
}

#[test]
fn nu_login_allowed_and_exec_rejected() {
    assert!(!rejected("nu", &["-l"]));
    assert!(!rejected("nu", &["--login"]));
    assert!(rejected("nu", &["-c", "x"]));
    assert!(rejected("nu", &["--commands", "x"]));
    // -e / --execute は「実行後に対話継続」だが任意コード実行なので拒否される
    assert!(rejected("nu", &["-e", "x"]));
    assert!(rejected("nu", &["script.nu"]));
}

// settings 登録済み完全コマンドラインは正規 opt-in として許可される
#[test]
fn registered_full_command_line_is_allowed() {
    let settings = serde_json::json!({
        "customAgents": [
            { "name": "wsl-dev", "command": "bash", "args": "--rcfile /home/dev/.devrc" }
        ]
    });
    let registered = registered_command_lines_from_value(&settings);
    let args = vec!["--rcfile".to_string(), "/home/dev/.devrc".to_string()];
    assert_eq!(
        reject_non_interactive_shell_args("bash", &args, &registered),
        None,
        "settings 登録済みの完全一致は許可"
    );
    // 完全一致でない (args が 1 つでも違う) 場合は通常どおり拒否
    let tampered = vec!["--rcfile".to_string(), "/tmp/evil".to_string()];
    assert!(
        reject_non_interactive_shell_args("bash", &tampered, &registered).is_some(),
        "登録と異なる args は拒否"
    );
    // 部分一致 (登録 args の先頭だけ) も拒否
    let partial = vec!["--rcfile".to_string()];
    assert!(
        reject_non_interactive_shell_args("bash", &partial, &registered).is_some(),
        "部分一致は拒否"
    );
}

#[test]
fn registered_command_lines_parse_all_sources() {
    let settings = serde_json::json!({
        "claudeCommand": "claude",
        "claudeArgs": "--dangerously-skip-permissions",
        "codexCommand": r#""C:\Program Files\Codex\codex.exe""#,
        "customAgents": [
            { "command": "nu", "args": "-e 'source init.nu'" }
        ]
    });
    let registered = registered_command_lines_from_value(&settings);
    assert!(registered.contains(&vec![
        "claude".to_string(),
        "--dangerously-skip-permissions".to_string()
    ]));
    assert!(registered.contains(&vec![r"c:\program files\codex\codex.exe".to_string()]));
    assert!(registered.contains(&vec![
        "nu".to_string(),
        "-e".to_string(),
        "source init.nu".to_string()
    ]));
}

#[test]
fn shell_detection_normalizes_paths() {
    // パス形式・拡張子付きでも basename 正規化されて契約の対象になる
    assert!(rejected("/usr/bin/zsh", &["-c", "evil"]));
    assert!(rejected(r"C:\Windows\System32\cmd.exe", &["/c", "evil"]));
    assert!(!rejected(r"C:\Windows\System32\cmd.exe", &["/q"]));
}

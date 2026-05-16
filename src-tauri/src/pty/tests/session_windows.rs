//! Issue #618 / #738: Windows コマンドパス解決 + UTF-8 init inject の integration test。
//!
//! 旧 `session.rs` 内の `spawn_command_resolution_tests` / `windows_utf8_inject_tests` /
//! `windows_utf8_e2e_tests` をそのまま移設したもの。cfg ゲートと `#[ignore]` 指定、
//! 期待値はすべて不変。

/// `maybe_inject_windows_utf8_init` の挙動テスト。Windows 専用ロジックだが関数自体は
/// platform-agnostic なので、cfg ゲートせず全プラットフォームで走らせる (旧 `session.rs`
/// の `windows_utf8_inject_tests` も `#[cfg(test)]` のみで windows ゲートは無かった)。
mod inject_tests {
    use crate::pty::session::spawn::maybe_inject_windows_utf8_init;
    use std::io;

    /// 書き込みが必ず失敗する Writer (write_all 試行で error を返す)。
    /// inject failure path のログを検証するための test double。
    struct FailingWriter;

    impl io::Write for FailingWriter {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::Error::new(io::ErrorKind::BrokenPipe, "test EPIPE"))
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn writes_chcp_for_cmd_when_enabled() {
        let mut buf: Vec<u8> = Vec::new();
        let res = maybe_inject_windows_utf8_init(&mut buf, "cmd", true).unwrap();
        assert_eq!(res, Some(&b"chcp 65001 > nul\r"[..]));
        assert_eq!(buf, b"chcp 65001 > nul\r");
    }

    #[test]
    fn writes_chcp_for_cmd_exe_full_path() {
        let mut buf: Vec<u8> = Vec::new();
        let res =
            maybe_inject_windows_utf8_init(&mut buf, r"C:\Windows\System32\cmd.exe", true).unwrap();
        assert!(res.is_some());
        assert_eq!(buf, b"chcp 65001 > nul\r");
    }

    #[test]
    fn writes_combined_init_for_powershell() {
        let mut buf: Vec<u8> = Vec::new();
        let res = maybe_inject_windows_utf8_init(&mut buf, "powershell", true).unwrap();
        assert!(res.is_some());
        let s = std::str::from_utf8(&buf).unwrap();
        assert!(s.contains("[Console]::OutputEncoding"));
        assert!(s.contains("UTF8Encoding"));
        assert!(s.contains("chcp 65001"));
        assert!(s.contains("> $null"));
        assert!(s.ends_with("\r"));
    }

    #[test]
    fn writes_combined_init_for_pwsh() {
        let mut buf: Vec<u8> = Vec::new();
        let res = maybe_inject_windows_utf8_init(&mut buf, "pwsh", true).unwrap();
        assert!(res.is_some());
        let s = std::str::from_utf8(&buf).unwrap();
        assert!(s.contains("[Console]::OutputEncoding"));
    }

    #[test]
    fn no_op_when_force_utf8_false() {
        let mut buf: Vec<u8> = Vec::new();
        let res = maybe_inject_windows_utf8_init(&mut buf, "cmd", false).unwrap();
        assert!(res.is_none());
        assert!(buf.is_empty(), "writer should not be touched when disabled");
    }

    #[test]
    fn no_op_for_bash() {
        let mut buf: Vec<u8> = Vec::new();
        let res = maybe_inject_windows_utf8_init(&mut buf, "bash", true).unwrap();
        assert!(res.is_none());
        assert!(buf.is_empty());
    }

    #[test]
    fn no_op_for_zsh_fish_nu() {
        for shell in ["zsh", "fish", "nu", "/usr/bin/zsh"] {
            let mut buf: Vec<u8> = Vec::new();
            let res = maybe_inject_windows_utf8_init(&mut buf, shell, true).unwrap();
            assert!(res.is_none(), "expected no-op for {shell}");
            assert!(buf.is_empty(), "expected empty buf for {shell}");
        }
    }

    #[test]
    fn no_op_for_claude_and_codex() {
        // Issue #618: Claude / Codex CLI は内部で UTF-8 出力するので chcp inject すると
        // CLI 側の prompt / banner と衝突する懸念があるため対象外。
        for cli in ["claude", "codex", r"C:\tools\codex.exe", "/usr/local/bin/claude"] {
            let mut buf: Vec<u8> = Vec::new();
            let res = maybe_inject_windows_utf8_init(&mut buf, cli, true).unwrap();
            assert!(res.is_none(), "expected no-op for {cli}");
        }
    }

    #[test]
    fn no_op_for_empty_or_unknown_command() {
        for cmd in ["", "nonexistent-shell"] {
            let mut buf: Vec<u8> = Vec::new();
            let res = maybe_inject_windows_utf8_init(&mut buf, cmd, true).unwrap();
            assert!(res.is_none(), "expected no-op for {:?}", cmd);
        }
    }

    #[test]
    fn propagates_write_error() {
        let mut writer = FailingWriter;
        let res = maybe_inject_windows_utf8_init(&mut writer, "cmd", true);
        assert!(res.is_err(), "writer error should bubble up");
        assert_eq!(res.unwrap_err().kind(), io::ErrorKind::BrokenPipe);
    }
}

/// Windows のコマンドパス解決 (PATHEXT / cmd.exe ラップ / fallback dir) の検証。
/// 実ファイルシステムを使うため Windows 限定。
#[cfg(windows)]
mod resolution_tests {
    use crate::pty::session::spawn::{
        prepare_spawn_command, resolve_terminal_command_path_for_check_with_env, SpawnOptions,
    };
    use crate::pty::session::windows_resolve::resolve_windows_spawn_command;
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};

    fn base_spawn_options(command: String, args: Vec<String>) -> SpawnOptions {
        SpawnOptions {
            command,
            args,
            cwd: ".".to_string(),
            is_codex: false,
            cols: 80,
            rows: 24,
            env: HashMap::new(),
            agent_id: None,
            session_key: None,
            team_id: None,
            role: None,
        }
    }

    #[test]
    fn resolves_cmd_from_opts_env_path_and_wraps_with_cmd_exe() {
        let tmp = tempfile::tempdir().unwrap();
        let cli = tmp.path().join("fakeagent.cmd");
        std::fs::write(&cli, "@echo off\r\n").unwrap();
        let mut env = HashMap::new();
        env.insert("PATH".to_string(), tmp.path().to_string_lossy().into_owned());

        let prepared =
            resolve_windows_spawn_command("fakeagent", vec!["--version".to_string()], &env)
                .unwrap();

        assert_eq!(
            Path::new(&prepared.program)
                .file_name()
                .and_then(|s| s.to_str())
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("cmd.exe")
        );
        assert_eq!(prepared.args[0], "/C");
        assert_eq!(PathBuf::from(&prepared.args[1]), cli);
        assert_eq!(prepared.args[2], "--version");
        assert_eq!(PathBuf::from(prepared.resolved_command), cli);
    }

    #[test]
    fn resolves_exe_without_cmd_wrapper() {
        let tmp = tempfile::tempdir().unwrap();
        let cli = tmp.path().join("fakeagent.exe");
        std::fs::write(&cli, "").unwrap();
        let mut env = HashMap::new();
        env.insert("PATH".to_string(), tmp.path().to_string_lossy().into_owned());

        let prepared =
            resolve_windows_spawn_command("fakeagent", vec!["--help".to_string()], &env).unwrap();

        assert_eq!(PathBuf::from(&prepared.program), cli);
        assert_eq!(prepared.args, vec!["--help"]);
    }

    #[test]
    fn prefers_cmd_over_extensionless_npm_shell_shim() {
        let tmp = tempfile::tempdir().unwrap();
        let shell_shim = tmp.path().join("codex");
        let cmd_shim = tmp.path().join("codex.cmd");
        std::fs::write(
            &shell_shim,
            "#!/bin/sh\nexec node \"$basedir/node_modules/.bin/codex\"\n",
        )
        .unwrap();
        std::fs::write(&cmd_shim, "@echo off\r\n").unwrap();
        let mut env = HashMap::new();
        env.insert("PATH".to_string(), tmp.path().to_string_lossy().into_owned());
        env.insert("PATHEXT".to_string(), ".COM;.EXE;.BAT;.CMD".to_string());

        let prepared =
            resolve_windows_spawn_command("codex", vec!["--version".to_string()], &env).unwrap();

        assert_eq!(PathBuf::from(&prepared.resolved_command), cmd_shim);
        assert_eq!(
            Path::new(&prepared.program)
                .file_name()
                .and_then(|s| s.to_str())
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("cmd.exe")
        );
        assert_eq!(prepared.args[0], "/C");
        assert_eq!(PathBuf::from(&prepared.args[1]), cmd_shim);
        assert_eq!(prepared.args[2], "--version");
    }

    #[test]
    fn normalizes_inline_command_again_at_spawn_boundary() {
        let tmp = tempfile::tempdir().unwrap();
        let cli = tmp.path().join("codex.exe");
        std::fs::write(&cli, "").unwrap();
        // Issue #788: spawn 境界の inline command 再 normalize を検証する。危険フラグ
        // 自体の拒否は command_validation 側のユニットテストでカバーするため、ここでは
        // benign な inline フラグを使い settings 状態に依存しないようにする。
        let command = format!(r#""{}" --foo"#, cli.display());
        let mut opts = base_spawn_options(
            command,
            vec![
                "--config".to_string(),
                "disable_paste_burst=true".to_string(),
            ],
        );

        let prepared = prepare_spawn_command(&opts).unwrap();

        assert_eq!(PathBuf::from(&prepared.program), cli);
        assert_eq!(
            prepared.args,
            vec!["--foo", "--config", "disable_paste_burst=true"]
        );

        opts.command = "cmd /c echo unsafe".to_string();
        opts.args.clear();
        let err = prepare_spawn_command(&opts).unwrap_err().to_string();
        assert!(err.contains("cmd immediate-exec flags"));
    }

    #[test]
    fn readiness_check_uses_same_windows_fallback_dirs_as_spawn() {
        let home = tempfile::tempdir().unwrap();
        let claude_dir = home.path().join(".local").join("bin");
        std::fs::create_dir_all(&claude_dir).unwrap();
        let claude = claude_dir.join("claude.exe");
        std::fs::write(&claude, "").unwrap();

        let appdata = home.path().join("AppData").join("Roaming");
        let npm_dir = appdata.join("npm");
        std::fs::create_dir_all(&npm_dir).unwrap();
        let codex = npm_dir.join("codex.cmd");
        std::fs::write(&codex, "@echo off\r\n").unwrap();

        let mut env = HashMap::new();
        env.insert(
            "PATH".to_string(),
            home.path().join("empty").to_string_lossy().into_owned(),
        );
        env.insert(
            "USERPROFILE".to_string(),
            home.path().to_string_lossy().into_owned(),
        );
        env.insert("APPDATA".to_string(), appdata.to_string_lossy().into_owned());
        env.insert(
            "LOCALAPPDATA".to_string(),
            home.path().join("LocalAppData").to_string_lossy().into_owned(),
        );

        assert_eq!(
            resolve_terminal_command_path_for_check_with_env("claude", &env).unwrap(),
            claude
        );
        assert_eq!(
            resolve_terminal_command_path_for_check_with_env("codex", &env).unwrap(),
            codex
        );
    }
}

/// Issue #618: Windows + cmd.exe で `chcp 65001` 後に `dir` が漢字ファイル名を UTF-8 で
/// 吐くことを実機で確認する E2E test。
///
/// **重要**: `cmd.exe /D /Q /C "chcp 65001 && dir"` のような 1 ショット混合では、cmd.exe が
/// `/C` 起動時に固定した OEM codepage を内部 `dir` に引き継いでしまうため UTF-8 化されない。
/// 一方、本来の prod 経路 (spawn_session 内で writer.write_all による inject) は対話的な
/// cmd.exe に対し独立したコマンドとして `chcp 65001\r` → ユーザーの `dir\r` を流すため正しく
/// 切り替わる。本 test では同じセマンティクス (= stdin パイプで chcp と dir を順番に流す)
/// を `std::process::Command` の piped stdin で再現して検証する。
///
/// CI では走らせず (`#[ignore]`)、ローカル Windows 環境で
/// `cargo test ... -- --ignored issue_618` で実行する想定。
#[cfg(windows)]
mod e2e_tests {
    use std::io::Write;
    use std::process::{Command, Stdio};

    /// chcp + dir を **別々のコマンド** として cmd.exe にパイプで流す。これは prod 経路の
    /// PTY writer による sequential inject と同じセマンティクス。
    #[test]
    #[ignore = "requires Windows + cmd.exe; run manually via -- --ignored"]
    fn issue_618_dir_displays_japanese() {
        // 1) 一時ディレクトリ + 漢字ファイル
        let tmp = std::env::temp_dir().join(format!("vibe-issue-618-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).expect("mkdir tmp");
        let jp_file = tmp.join("テスト_漢字_618.txt");
        std::fs::write(&jp_file, b"hello").expect("write jp file");

        // 2) cmd.exe /D /Q を起動し、stdin に chcp + dir + exit を順番に流す
        let mut child = Command::new("cmd.exe")
            .args(["/D", "/Q"])
            .current_dir(&tmp)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn cmd.exe failed (PATH に cmd.exe が無い?)");

        // stdin 経由で sequential 入力。これが prod の PTY writer 経由 inject と等価。
        {
            let stdin = child.stdin.as_mut().expect("stdin");
            // prod 経路と同じバイト列を流す (chcp 65001 > nul + dir + exit)
            stdin.write_all(b"chcp 65001 > nul\r\n").expect("write chcp");
            stdin.write_all(b"dir\r\n").expect("write dir");
            stdin.write_all(b"exit\r\n").expect("write exit");
            stdin.flush().expect("flush stdin");
        }

        let output = child.wait_with_output().expect("wait child");
        let stdout_lossy = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr_lossy = String::from_utf8_lossy(&output.stderr).to_string();
        eprintln!(
            "[issue-618 e2e] exit={:?} stdout={} bytes\n--- stdout ---\n{}\n--- stderr ---\n{}",
            output.status.code(),
            output.stdout.len(),
            stdout_lossy,
            stderr_lossy
        );

        // 3) lossy UTF-8 decode しても U+FFFD で化けず、漢字ファイル名がそのまま含まれること
        assert!(output.status.success(), "cmd.exe exited non-zero");
        assert!(!output.stdout.is_empty(), "expected non-empty dir output");
        assert!(
            !stdout_lossy.contains("\u{FFFD}_618.txt"),
            "expected Japanese filename in UTF-8 (no U+FFFD before _618.txt), got:\n{stdout_lossy}"
        );
        assert!(
            stdout_lossy.contains("テスト_漢字_618.txt"),
            "expected exact Japanese filename in UTF-8 dir output, got:\n{stdout_lossy}"
        );

        // cleanup
        let _ = std::fs::remove_file(&jp_file);
        let _ = std::fs::remove_dir(&tmp);
    }

    /// 対比用: chcp 65001 を入れず、素の cmd.exe で `dir` を流すと CP932 で書かれ、
    /// `String::from_utf8_lossy` で漢字が U+FFFD に化けることを示す。
    /// host が既に UTF-8 codepage の場合 (例: chcp 65001 が host グローバルに効いている / ja 以外
    /// の locale) はこの baseline が成立しないので、その時は assertion をスキップして pass させる。
    #[test]
    #[ignore = "requires Windows + cmd.exe (CP932 default); run manually via -- --ignored"]
    fn issue_618_baseline_without_chcp_corrupts_japanese() {
        let tmp = std::env::temp_dir().join(format!("vibe-issue-618-base-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).expect("mkdir tmp");
        let jp_file = tmp.join("テスト_漢字_618.txt");
        std::fs::write(&jp_file, b"hello").expect("write jp file");

        // chcp なしで dir
        let mut child = Command::new("cmd.exe")
            .args(["/D", "/Q"])
            .current_dir(&tmp)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn cmd.exe failed");
        {
            let stdin = child.stdin.as_mut().expect("stdin");
            stdin.write_all(b"dir\r\n").expect("write dir");
            stdin.write_all(b"exit\r\n").expect("write exit");
        }
        let output = child.wait_with_output().expect("wait child");
        let stdout_lossy = String::from_utf8_lossy(&output.stdout).to_string();

        eprintln!(
            "[issue-618 e2e baseline] {} bytes, decoded as UTF-8:\n{}",
            output.stdout.len(),
            stdout_lossy
        );
        assert!(output.status.success());
        assert!(!output.stdout.is_empty());

        // host の active codepage を確認。932 のときだけ U+FFFD を期待 (= baseline 条件).
        let active_cp = Command::new("cmd.exe")
            .args(["/D", "/Q", "/C", "chcp"])
            .output()
            .expect("chcp query");
        let cp_str = String::from_utf8_lossy(&active_cp.stdout).to_string();
        eprintln!("[issue-618 e2e baseline] active codepage: {}", cp_str.trim());
        if cp_str.contains("932") {
            assert!(
                stdout_lossy.contains("\u{FFFD}"),
                "on CP932 host expected U+FFFD in lossy-UTF8 decode, got:\n{stdout_lossy}"
            );
        }

        let _ = std::fs::remove_file(&jp_file);
        let _ = std::fs::remove_dir(&tmp);
    }
}

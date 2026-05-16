//! Issue #738: PTY spawn 時の親プロセス環境変数 allowlist。
//!
//! 旧 `session.rs` の `should_inherit_env` をそのまま切り出したもの。判定ロジックは
//! 変えていない。ユニットテストは `pty/tests/session_env.rs` (integration) へ移設した。

/// Issue #211:
/// 親プロセス env を denylist ではなく allowlist で継承する。
/// TeamHub 用の内部 env は `opts.env` から明示注入されたものだけが後段で渡る。
pub(crate) fn should_inherit_env(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    if upper.starts_with("LC_") || upper.starts_with("XDG_") {
        return true;
    }
    matches!(
        upper.as_str(),
        "PATH"
            | "PATHEXT"
            | "HOME"
            | "PWD"
            | "USER"
            | "USERNAME"
            | "LOGNAME"
            | "LANG"
            | "TERM"
            | "COLORTERM"
            | "SHELL"
            | "TMP"
            | "TEMP"
            | "TMPDIR"
            | "TZ"
            | "SYSTEMROOT"
            | "WINDIR"
            | "COMSPEC"
            | "APPDATA"
            | "LOCALAPPDATA"
            | "PROGRAMDATA"
            | "PROGRAMFILES"
            | "PROGRAMFILES(X86)"
            | "COMMONPROGRAMFILES"
            | "COMMONPROGRAMFILES(X86)"
            | "USERPROFILE"
            | "HOMEDRIVE"
            | "HOMEPATH"
            | "OS"
            | "NUMBER_OF_PROCESSORS"
            | "PROCESSOR_ARCHITECTURE"
            | "PROCESSOR_IDENTIFIER"
            | "WT_SESSION"
            | "WT_PROFILE_ID"
            | "MSYSTEM"
            | "WSLENV"
            | "WSL_DISTRO_NAME"
    )
}

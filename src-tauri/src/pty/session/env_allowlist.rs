//! Issue #738: PTY spawn 時の親プロセス環境変数 allowlist。
//!
//! 旧 `session.rs` の `should_inherit_env` をそのまま切り出したもの。判定ロジックは
//! 変えていない。ユニットテストは `pty/tests/session_env.rs` (integration) へ移設した。

/// Issue #211:
/// 親プロセス env を denylist ではなく allowlist で継承する。
/// renderer 由来の `opts.env` は信頼境界 (`commands/terminal.rs` の terminal_create) で
/// `is_safe_renderer_env_key` により濾過され、通過したものだけが後段で渡る (Issue #889)。
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

/// Issue #889: renderer (信頼境界外) が `opts.env` 経由で子プロセスへ渡してよいキーか。
/// TeamHub 用の `VIBE_*` のみ許可する allowlist。`NODE_OPTIONS` / `LD_PRELOAD` /
/// `DYLD_INSERT_LIBRARIES` 等の任意コード実行に繋がる env を一律ブロックする。
/// Windows の env 名は case 非依存のため大文字化して判定する。
/// 将来 renderer が `VIBE_*` 以外の env を正規に渡したくなった場合は、ここへ
/// 明示追加する (denylist 化はしない)。
pub(crate) fn is_safe_renderer_env_key(key: &str) -> bool {
    key.to_ascii_uppercase().starts_with("VIBE_")
}

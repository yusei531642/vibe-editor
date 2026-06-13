//! Issue #983: spawn の telemetry / ラベル付けヘルパを `spawn.rs` から分離。
//!
//! `build_cmd_label` / `engine_label` / `platform_label` / `log_spawn_outcome` は
//! spawn の所要時間・結果ログを整形するための純粋関数群で、spawn 本体の制御フロー
//! (PTY open / reader thread / exit watcher) からは独立している。状態を持たないため
//! 所有権の境界も発生しない。挙動・ログフォーマットは spawn.rs にあった頃から一切
//! 変えていない (純粋な move)。

use super::spawn::PreparedSpawnCommand;
use crate::util::log_redact::redact_home;

/// Issue #579: spawn ログ用に「漏洩しない短い command ラベル」を作る。
///
/// resolved_command はフルパス (例: `C:\Users\foo\AppData\Roaming\npm\claude.cmd`) を
/// 持ちうるので、basename だけ取り出してさらに `redact_home` を通す。`Path::file_name`
/// は Unix 上で Windows 区切り `\` を解釈しないため、cross-platform に動かすには
/// 両方の区切りで rsplit する。
pub(crate) fn build_cmd_label(prepared: &PreparedSpawnCommand) -> String {
    let basename = prepared
        .resolved_command
        .rsplit(['/', '\\'])
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(prepared.requested_command.as_str())
        .to_string();
    redact_home(&basename)
}

pub(crate) fn engine_label(is_codex: bool) -> &'static str {
    if is_codex {
        "codex"
    } else {
        "claude"
    }
}

pub(crate) fn platform_label() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "other"
    }
}

/// Issue #579: PTY spawn の所要時間 + 結果を tracing で記録する。
/// 集計は `target=pty` + メッセージ `[pty] spawn ok` / `[pty] spawn failed` で grep する想定。
/// 詳細は `tasks/issue-579/notes.md` を参照。
pub(crate) fn log_spawn_outcome(
    cmd_label: &str,
    engine: &str,
    platform: &str,
    elapsed_ms: u64,
    error: Option<&str>,
) {
    match error {
        None => tracing::info!(
            target: "pty",
            command = %cmd_label,
            engine = %engine,
            platform = %platform,
            elapsed_ms = elapsed_ms,
            "[pty] spawn ok"
        ),
        Some(err) => tracing::warn!(
            target: "pty",
            command = %cmd_label,
            engine = %engine,
            platform = %platform,
            elapsed_ms = elapsed_ms,
            error = %err,
            "[pty] spawn failed"
        ),
    }
}

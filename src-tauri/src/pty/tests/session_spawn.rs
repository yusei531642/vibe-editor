//! Issue #579 / #738: PTY spawn の所要時間ログ周りのユニットテスト。
//!
//! 旧 `session.rs` 内 `spawn_metrics_tests` をそのまま移設したもの。
//!
//! 実 PTY を立てる E2E は CI が遅いため避け、ヘルパ関数の単体挙動と
//! 自前の captured-writer subscriber で `[pty] spawn ok` / `[pty] spawn failed`
//! の出力を確認する軽量テストに留める。`tracing-test` を使わないのは、
//! こちらの subscriber は `target: "pty"` を自分の crate filter で弾かない
//! (test ローカルに `with_default` で全 target を拾う) ため。

use crate::pty::session::spawn::{
    build_cmd_label, engine_label, log_spawn_outcome, platform_label, PreparedSpawnCommand,
};
use std::io::Write;
use std::sync::{Arc, Mutex};
use tracing_subscriber::fmt::MakeWriter;

fn fixture(resolved: &str, requested: &str) -> PreparedSpawnCommand {
    PreparedSpawnCommand {
        requested_command: requested.to_string(),
        resolved_command: resolved.to_string(),
        program: resolved.to_string(),
        args: vec![],
        path_entries: 0,
        pathext_present: false,
    }
}

#[derive(Clone, Default)]
struct CapturedWriter(Arc<Mutex<Vec<u8>>>);

impl Write for CapturedWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for CapturedWriter {
    type Writer = Self;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

fn capture<F: FnOnce()>(f: F) -> String {
    let writer = CapturedWriter::default();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(writer.clone())
        .with_max_level(tracing::Level::TRACE)
        .with_target(true)
        .with_ansi(false)
        .finish();
    tracing::subscriber::with_default(subscriber, f);
    let buf = writer.0.lock().unwrap().clone();
    String::from_utf8(buf).unwrap_or_default()
}

#[test]
fn engine_label_picks_codex_when_flag_set() {
    assert_eq!(engine_label(true), "codex");
    assert_eq!(engine_label(false), "claude");
}

#[test]
fn platform_label_returns_known_value() {
    let p = platform_label();
    assert!(matches!(p, "windows" | "macos" | "linux" | "other"));
}

#[test]
fn build_cmd_label_strips_windows_path() {
    let prepared = fixture(r"C:\Users\foo\AppData\Roaming\npm\claude.cmd", "claude");
    assert_eq!(build_cmd_label(&prepared), "claude.cmd");
}

#[test]
fn build_cmd_label_strips_unix_path() {
    let prepared = fixture("/usr/local/bin/codex", "codex");
    assert_eq!(build_cmd_label(&prepared), "codex");
}

#[test]
fn build_cmd_label_falls_back_to_requested_when_resolved_empty() {
    let prepared = fixture("", "claude");
    assert_eq!(build_cmd_label(&prepared), "claude");
}

#[test]
fn log_spawn_outcome_emits_info_on_success() {
    let logs = capture(|| {
        log_spawn_outcome("claude.cmd", "claude", "windows", 123, None);
    });
    // tracing-subscriber の既定 formatter は文字列フィールドを quote しないので
    // `engine=claude` のように key=value (no quotes) で照合する。集計用 grep の
    // 想定もこの形 (`Select-String 'engine=claude'`)。
    assert!(
        logs.contains("[pty] spawn ok"),
        "expected `[pty] spawn ok` in logs but got: {logs}"
    );
    assert!(logs.contains("elapsed_ms=123"), "logs: {logs}");
    assert!(logs.contains("engine=claude"), "logs: {logs}");
    assert!(logs.contains("platform=windows"), "logs: {logs}");
    assert!(logs.contains("command=claude.cmd"), "logs: {logs}");
    // target=pty が prefix 部分に出る (`INFO pty:` のような行になる)
    assert!(logs.contains("pty:"), "expected `pty:` target prefix: {logs}");
    // INFO レベルで出ていること (failed は warn)
    assert!(logs.contains("INFO"), "logs: {logs}");
    assert!(
        !logs.contains("[pty] spawn failed"),
        "success path emitted failure log: {logs}"
    );
}

#[test]
fn log_spawn_outcome_emits_warn_on_failure() {
    let logs = capture(|| {
        log_spawn_outcome(
            "codex.cmd",
            "codex",
            "windows",
            456,
            Some("executable not found"),
        );
    });
    assert!(
        logs.contains("[pty] spawn failed"),
        "expected `[pty] spawn failed` in logs but got: {logs}"
    );
    assert!(logs.contains("elapsed_ms=456"), "logs: {logs}");
    assert!(logs.contains("engine=codex"), "logs: {logs}");
    assert!(logs.contains("error=executable not found"), "logs: {logs}");
    // WARN レベルで出ていること
    assert!(logs.contains("WARN"), "logs: {logs}");
}

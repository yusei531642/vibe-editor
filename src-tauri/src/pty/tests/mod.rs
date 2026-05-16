//! Issue #494: PTY 周辺の integration test 集約モジュール。
//!
//! `batcher` の flush 境界条件 (UTF-8 安全境界 / 16ms tick / 32KiB バッファ閾値) を
//! Tauri AppHandle に依存せず純粋関数経由で検証する。
//!
//! Issue #738: `session.rs` 分割に伴い、旧 `session.rs` 内の `env_strip_tests` /
//! `spawn_metrics_tests` / `spawn_command_resolution_tests` / `windows_utf8_*_tests` を
//! `session_env` / `session_spawn` / `session_windows` として移設した。

mod batcher;
mod session_env;
mod session_spawn;
mod session_windows;

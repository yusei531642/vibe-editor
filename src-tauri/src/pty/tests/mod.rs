//! Issue #494: PTY 周辺の integration test 集約モジュール。
//!
//! `batcher` の flush 境界条件 (UTF-8 安全境界 / 16ms tick / 32KiB バッファ閾値) を
//! Tauri AppHandle に依存せず純粋関数経由で検証する。

mod batcher;

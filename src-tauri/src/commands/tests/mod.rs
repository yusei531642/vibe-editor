//! Issue #494: `commands/*.rs` の integration test 集約モジュール。
//!
//! Phase 1 (PR #492) で固まった `commands/error.rs` / `util/config_paths.rs` 統一、
//! Phase 2 (PR #501) で固まった `Settings` strong-typed serde struct を活用し、
//! IPC 境界に対する end-to-end テストをここに置く。
//!
//! 構成:
//! - `settings` — `commands::settings::Settings` の serde / atomic_write 経由 round-trip
//! - `git` — `git_status` / `git_diff` を fixture repo (tempdir + git CLI) に対して走らせる
//! - `sessions` — `read_jsonl_summary` を fixture jsonl に対して走らせる

mod git;
mod sessions;
mod settings;

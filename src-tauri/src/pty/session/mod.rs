//! PTY セッション本体。
//!
//! 旧 `ipc/terminal.ts` の `pty.spawn(...)` 部分を移植。
//! portable-pty + tokio + tauri::Emitter で同等機能を再現。
//!
//! Issue #738: 旧 `session.rs` (約 1800 行) を以下のサブモジュールに分割した。
//! 公開 API (`crate::pty::session::*` のパス) はこの `mod.rs` の re-export で
//! 旧構成と互換に保っており、外部 (`pty/mod.rs` / `registry.rs` / `commands/` /
//! `team_hub/`) からの参照は一切変えていない。
//!
//! - [`handle`] — `SessionHandle` (4 つの `Mutex` を持つセッション状態) + `Drop` +
//!   `UserWriteOutcome` / `TerminalExitInfo`。
//! - [`spawn`] — `SpawnOptions` と `spawn_session` / `resolve_valid_cwd` /
//!   コマンドパス解決 / spawn メトリクスログ。
//! - [`env_allowlist`] — 親プロセス環境変数の継承 allowlist (`should_inherit_env`)。
//! - [`windows_resolve`] — Windows 専用のコマンドパス解決 (`#[cfg(windows)]`)。
//! - [`unix_path`] — macOS / Linux 専用の PATH 補強 (`#[cfg(not(windows))]`,
//!   Issue #979: GUI 起動時にログインシェル PATH を継承しない問題への対処)。
//! - [`injecting_guard`] — `injecting` フラグの RAII guard (`InjectingGuard`)。
//! - [`lock`] — 4 つの `Mutex` lock 取得を 1 つに集約する `lock_poisoned!` macro。

pub(crate) mod env_allowlist;
// Issue #1098: exit イベント payload 型 (`TerminalExitInfo`) と exit code 正規化 /
// 末尾出力サマリ生成。`spawn.rs` の exit watcher が参照する (外部からはパス参照しない)。
mod exit_info;
mod exit_watcher;
mod handle;
mod injecting_guard;
mod lock;
mod registration;
mod termination;
pub(crate) mod spawn;
pub(crate) mod spawn_metrics;
#[cfg(not(windows))]
pub(crate) mod unix_path;
#[cfg(windows)]
pub(crate) mod windows_resolve;

// 外部 (`pty/mod.rs` / `registry.rs` / `commands/` / `team_hub/`) から
// `crate::pty::session::*` のパスで参照される公開 API。旧 `session.rs` 直下に
// あった `pub` 項目のうち、実際に外部から名前で import されるものだけを再エクスポートする。
// `TerminalExitInfo` (emit payload) と `InjectingGuard` (`begin_injecting` の戻り値型) は
// `pub` のまま各サブモジュールに置く — 外部はパス参照しないため再エクスポート不要。
pub use handle::{SessionHandle, UserWriteOutcome};
pub use termination::TerminationReason;
pub(crate) use registration::RegistrationLatch;
pub use spawn::{resolve_valid_cwd, spawn_session, SpawnOptions, TerminalWarning};

// Issue #937: registry の kill_team テスト等が mock killer 付き handle を作れるよう、
// テスト専用の構築 helper を crate 内へ再エクスポートする (`handle` モジュール自体は private)。
#[cfg(test)]
pub(crate) use handle::test_support;

pub(crate) use spawn::resolve_terminal_command_path_for_check;

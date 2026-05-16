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
//! - [`injecting_guard`] — `injecting` フラグの RAII guard (`InjectingGuard`)。
//! - [`lock`] — 4 つの `Mutex` lock 取得を 1 つに集約する `lock_poisoned!` macro。

pub(crate) mod env_allowlist;
mod handle;
mod injecting_guard;
mod lock;
pub(crate) mod spawn;
#[cfg(windows)]
pub(crate) mod windows_resolve;

// 外部 (`pty/mod.rs` / `registry.rs` / `commands/` / `team_hub/`) から
// `crate::pty::session::*` のパスで参照される公開 API。旧 `session.rs` 直下に
// あった `pub` 項目のうち、実際に外部から名前で import されるものだけを再エクスポートする。
// `TerminalExitInfo` (emit payload) と `InjectingGuard` (`begin_injecting` の戻り値型) は
// `pub` のまま各サブモジュールに置く — 外部はパス参照しないため再エクスポート不要。
pub use handle::{SessionHandle, UserWriteOutcome};
pub use spawn::{resolve_valid_cwd, spawn_session, SpawnOptions};

pub(crate) use spawn::resolve_terminal_command_path_for_check;

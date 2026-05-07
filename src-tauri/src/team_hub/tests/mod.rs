//! Issue #494: TeamHub の integration test 集約モジュール。
//!
//! Phase 2 (PR #501 / Issue #493) で `Permission` enum + `check_permission()` に統一した
//! 権限チェック層を、各 role × tool のマトリクスで end-to-end に走らせる。
//!
//! recruit / dismiss / send / assign_task の RPC simulation は Tauri `AppHandle` の
//! event emit を経由するため `cargo test` 単独では完結しない (mock framework 不採用)。
//! ここでは Hub state 操作を伴わない pure な permission table を中心にカバーする。

mod permissions;

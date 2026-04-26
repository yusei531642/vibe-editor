// PTY モジュール
//
// 旧 src/main/ipc/terminal.ts + lib/{session-registry,pty-data-batcher,
// claude-session-watcher,resolve-command}.ts の Rust 移植版。
//
// 設計:
// - portable-pty で PTY ペアを開く (Windows は ConPTY)
// - reader thread が標準スレッドで master からブロッキング read
// - 読み取ったバイトを mpsc → batcher (16ms or 32KB) → tauri emit
// - writer は Mutex で保護、resize/kill 用に master の参照も保持
// - SessionRegistry は AppState 経由で共有

pub mod batcher;
pub mod claude_watcher;
pub mod path_norm;
pub mod registry;
pub mod session;

pub use registry::SessionRegistry;
pub use session::{spawn_session, SpawnOptions, UserWriteOutcome};

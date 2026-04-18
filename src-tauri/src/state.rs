// アプリ全体の共有 state

use crate::pty::SessionRegistry;
use crate::team_hub::TeamHub;
use std::sync::{Arc, Mutex};

pub struct AppState {
    /// 現在 UI で開いているプロジェクトルート。
    ///
    /// Issue #56 注記:
    ///   `std::sync::Mutex` を async コンテキスト (tokio task) から `.lock()` するのは
    ///   通常アンチパターンだが、ここは `lock → clone → unlock` のみで重い処理は入れない。
    ///   クリティカル区間を絶対に短く保つこと (canonicalize / fs I/O を lock 保持中に
    ///   行ってはいけない)。lock 保持中に `.await` は絶対禁止。
    ///   将来的に重い処理が必要になったら parking_lot::Mutex か tokio::sync::RwLock に
    ///   切り替えること。
    pub project_root: Mutex<Option<String>>,
    pub pty_registry: Arc<SessionRegistry>,
    pub team_hub: TeamHub,
}

impl AppState {
    pub fn new() -> Self {
        let pty_registry = Arc::new(SessionRegistry::new());
        let team_hub = TeamHub::new(pty_registry.clone());
        Self {
            project_root: Mutex::new(None),
            pty_registry,
            team_hub,
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

// アプリ全体の共有 state

use crate::pty::SessionRegistry;
use crate::team_hub::TeamHub;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Issue #56: async context から触るので tokio::sync::Mutex に揃える。
/// project_root は読みが多く書きが稀なので、単純な Mutex で十分 (RwLock 化は追加コストに見合わない)。
pub struct AppState {
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

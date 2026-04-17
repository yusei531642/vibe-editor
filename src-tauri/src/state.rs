// アプリ全体の共有 state

use crate::pty::SessionRegistry;
use crate::team_hub::TeamHub;
use std::sync::{Arc, Mutex};

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

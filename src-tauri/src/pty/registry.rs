// PTY セッション registry (旧 lib/session-registry.ts 等価)
//
// id → Arc<SessionHandle> の HashMap + agent_id → id の二次 index。
// TeamHub 側からは agent_id 経由で SessionHandle を引きたいので両方持つ。

use crate::pty::session::SessionHandle;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct Inner {
    by_id: HashMap<String, Arc<SessionHandle>>,
    by_agent: HashMap<String, String>, // agent_id → session_id
}

#[derive(Default)]
pub struct SessionRegistry {
    inner: Mutex<Inner>,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&self, id: String, handle: SessionHandle) {
        let mut g = self.inner.lock().expect("registry lock poisoned");
        if let Some(aid) = handle.agent_id.clone() {
            g.by_agent.insert(aid, id.clone());
        }
        g.by_id.insert(id, Arc::new(handle));
    }

    pub fn get(&self, id: &str) -> Option<Arc<SessionHandle>> {
        let g = self.inner.lock().expect("registry lock poisoned");
        g.by_id.get(id).cloned()
    }

    /// agent_id 経由で取得 (TeamHub がメッセージ注入時に使う)
    pub fn get_by_agent(&self, agent_id: &str) -> Option<Arc<SessionHandle>> {
        let g = self.inner.lock().expect("registry lock poisoned");
        g.by_agent
            .get(agent_id)
            .and_then(|sid| g.by_id.get(sid).cloned())
    }

    /// 同一 team_id の (agent_id, role) ペア一覧 (TeamHub の broadcast/team_info で使う)
    pub fn list_team_members(&self, team_id: &str) -> Vec<(String, String)> {
        let g = self.inner.lock().expect("registry lock poisoned");
        g.by_id
            .values()
            .filter_map(|s| {
                let aid = s.agent_id.clone()?;
                if s.team_id.as_deref() == Some(team_id) {
                    Some((aid, s.role.clone().unwrap_or_default()))
                } else {
                    None
                }
            })
            .collect()
    }

    pub fn remove(&self, id: &str) -> Option<Arc<SessionHandle>> {
        let mut g = self.inner.lock().expect("registry lock poisoned");
        if let Some(handle) = g.by_id.remove(id) {
            if let Some(aid) = &handle.agent_id {
                if g.by_agent.get(aid).map(String::as_str) == Some(id) {
                    g.by_agent.remove(aid);
                }
            }
            Some(handle)
        } else {
            None
        }
    }

    pub fn kill_all(&self) {
        let mut g = self.inner.lock().expect("registry lock poisoned");
        g.by_agent.clear();
        for (_, s) in g.by_id.drain() {
            let _ = s.kill();
        }
    }

    pub fn len(&self) -> usize {
        self.inner.lock().map(|g| g.by_id.len()).unwrap_or(0)
    }
}

// PTY セッション registry (旧 lib/session-registry.ts 等価)
//
// id → Arc<SessionHandle> の HashMap + agent_id → id の二次 index。
// TeamHub 側からは agent_id 経由で SessionHandle を引きたいので両方持つ。

use crate::pty::session::SessionHandle;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

/// Mutex が poison していたら warn ログを出し、data を取り出して処理を継続する。
/// panic はしない (上位が IPC 層の場合 panic はプロセスごと吹き飛ばすため)。
fn recover<'a, T>(
    result: Result<MutexGuard<'a, T>, PoisonError<MutexGuard<'a, T>>>,
) -> MutexGuard<'a, T> {
    match result {
        Ok(g) => g,
        Err(poisoned) => {
            tracing::warn!("[registry] mutex poisoned — recovering inner data");
            poisoned.into_inner()
        }
    }
}

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
        let mut g = recover(self.inner.lock());
        // Issue #42: 同じ agent_id で再 spawn されると、旧 session_id を by_agent が手放した後も
        // by_id に旧 SessionHandle が残り続け、以後 kill されない孤立 PTY になる。
        // insert 時点で同 agent_id の旧 session があれば、by_id から取り出して kill + drop する。
        if let Some(aid) = handle.agent_id.clone() {
            if let Some(prev_sid) = g.by_agent.insert(aid, id.clone()) {
                if prev_sid != id {
                    if let Some(old) = g.by_id.remove(&prev_sid) {
                        tracing::info!(
                            "[registry] replacing session {prev_sid} with {id} — killing old PTY"
                        );
                        let _ = old.kill();
                    }
                }
            }
        }
        g.by_id.insert(id, Arc::new(handle));
    }

    pub fn get(&self, id: &str) -> Option<Arc<SessionHandle>> {
        let g = recover(self.inner.lock());
        g.by_id.get(id).cloned()
    }

    /// agent_id 経由で取得 (TeamHub がメッセージ注入時に使う)
    pub fn get_by_agent(&self, agent_id: &str) -> Option<Arc<SessionHandle>> {
        let g = recover(self.inner.lock());
        g.by_agent
            .get(agent_id)
            .and_then(|sid| g.by_id.get(sid).cloned())
    }

    /// 同一 team_id の (agent_id, role) ペア一覧 (TeamHub の broadcast/team_info で使う)
    pub fn list_team_members(&self, team_id: &str) -> Vec<(String, String)> {
        let g = recover(self.inner.lock());
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
        let mut g = recover(self.inner.lock());
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
        let mut g = recover(self.inner.lock());
        g.by_agent.clear();
        for (_, s) in g.by_id.drain() {
            let _ = s.kill();
        }
    }

    pub fn len(&self) -> usize {
        recover(self.inner.lock()).by_id.len()
    }
}

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
    /// Issue #271: HMR 経路で「同じ React mount identity の生存 PTY」を逆引きする index。
    /// agent_id を持たない Canvas TerminalCard / IDE タブも attach 対象にできる。
    by_session_key: HashMap<String, String>, // session_key → session_id
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
        // Issue #271: HMR 経路では terminal_create の preflight (find_attach_target) で
        // 既存 PTY に attach するため、ここまで到達するのは「本当に新しい PTY を生やしたい場合」
        // (通常 spawn / restart) のみ。よって insert 時の旧 PTY kill は維持して問題ない。
        if let Some(aid) = handle.agent_id.clone() {
            if let Some(prev_sid) = g.by_agent.insert(aid, id.clone()) {
                if prev_sid != id {
                    if let Some(old) = g.by_id.remove(&prev_sid) {
                        // by_session_key からも掃除する (古い session_id を指す entry を消す)
                        if let Some(old_key) = &old.session_key {
                            if g.by_session_key.get(old_key).map(String::as_str)
                                == Some(prev_sid.as_str())
                            {
                                g.by_session_key.remove(old_key);
                            }
                        }
                        tracing::info!(
                            "[registry] replacing session {prev_sid} with {id} — killing old PTY"
                        );
                        let _ = old.kill();
                    }
                }
            }
        }
        // Issue #271: session_key index を更新。同 key の旧 entry は preflight で attach されて
        // いるはずだが、安全側に倒して既存 entry を上書きしておく (孤立しない限り旧 PTY は別経路で kill 済み)。
        if let Some(skey) = handle.session_key.clone() {
            if let Some(prev_sid) = g.by_session_key.insert(skey, id.clone()) {
                if prev_sid != id {
                    if let Some(old) = g.by_id.remove(&prev_sid) {
                        if let Some(aid) = &old.agent_id {
                            if g.by_agent.get(aid).map(String::as_str) == Some(prev_sid.as_str())
                            {
                                g.by_agent.remove(aid);
                            }
                        }
                        tracing::info!(
                            "[registry] replacing session_key entry {prev_sid} with {id} — killing old PTY"
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

    /// Issue #271: HMR remount で attach 候補となる生存 PTY の session_id を探す。
    /// session_key を最優先 (Canvas 通常 Terminal は agent_id を持たないため)、
    /// 次に agent_id を見る。`by_id` に entry がない孤立 index は無視する。
    pub fn find_attach_target(
        &self,
        session_key: Option<&str>,
        agent_id: Option<&str>,
    ) -> Option<String> {
        let g = recover(self.inner.lock());
        if let Some(k) = session_key {
            if let Some(sid) = g.by_session_key.get(k) {
                if g.by_id.contains_key(sid) {
                    return Some(sid.clone());
                }
            }
        }
        if let Some(a) = agent_id {
            if let Some(sid) = g.by_agent.get(a) {
                if g.by_id.contains_key(sid) {
                    return Some(sid.clone());
                }
            }
        }
        None
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
            // Issue #271: session_key index も同期して掃除する。
            if let Some(skey) = &handle.session_key {
                if g.by_session_key.get(skey).map(String::as_str) == Some(id) {
                    g.by_session_key.remove(skey);
                }
            }
            // Issue #144: registry から外しただけだと、Arc の参照が他所に残っているとき
            // 子プロセス / reader thread が永久に生き続ける。明示的に kill を要求して、
            // PTY master 経由の read を EOF にし、reader thread を自然終了させる。
            // ※ Drop impl も kill するが「最後の Arc が drop されるまで」遅れるため、
            //   ここで早期 kill しておく。
            let _ = handle.kill();
            Some(handle)
        } else {
            None
        }
    }

    pub fn kill_all(&self) {
        let mut g = recover(self.inner.lock());
        g.by_agent.clear();
        g.by_session_key.clear();
        for (_, s) in g.by_id.drain() {
            let _ = s.kill();
        }
    }

    pub fn len(&self) -> usize {
        recover(self.inner.lock()).by_id.len()
    }
}

#[cfg(test)]
mod attach_lookup_tests {
    //! Issue #271: find_attach_target は SessionHandle を作らずとも、
    //! `by_session_key` / `by_agent` / `by_id` の HashMap を直接組めば検証可能。
    //! ここでは pure な lookup ロジックを `lookup_attach` 関数に切り出して検証する。
    //! 本実装の `SessionRegistry::find_attach_target` も同じロジックなので、両者の挙動が
    //! 一致していれば session_key 優先・agent_id フォールバック・孤立 index の無視が担保される。
    use super::*;
    use std::collections::HashSet;

    /// 本実装と同じロジックの pure 関数版
    fn lookup_attach(
        by_id_keys: &HashSet<String>,
        by_session_key: &HashMap<String, String>,
        by_agent: &HashMap<String, String>,
        session_key: Option<&str>,
        agent_id: Option<&str>,
    ) -> Option<String> {
        if let Some(k) = session_key {
            if let Some(sid) = by_session_key.get(k) {
                if by_id_keys.contains(sid) {
                    return Some(sid.clone());
                }
            }
        }
        if let Some(a) = agent_id {
            if let Some(sid) = by_agent.get(a) {
                if by_id_keys.contains(sid) {
                    return Some(sid.clone());
                }
            }
        }
        None
    }

    #[test]
    fn session_key_takes_priority_over_agent_id() {
        let mut by_id = HashSet::new();
        by_id.insert("sid-skey".to_string());
        by_id.insert("sid-agent".to_string());
        let mut by_session_key = HashMap::new();
        by_session_key.insert("k1".to_string(), "sid-skey".to_string());
        let mut by_agent = HashMap::new();
        by_agent.insert("a1".to_string(), "sid-agent".to_string());

        let got = lookup_attach(&by_id, &by_session_key, &by_agent, Some("k1"), Some("a1"));
        assert_eq!(got.as_deref(), Some("sid-skey"));
    }

    #[test]
    fn falls_back_to_agent_id_when_session_key_missing() {
        let mut by_id = HashSet::new();
        by_id.insert("sid-agent".to_string());
        let by_session_key = HashMap::new();
        let mut by_agent = HashMap::new();
        by_agent.insert("a1".to_string(), "sid-agent".to_string());

        let got = lookup_attach(&by_id, &by_session_key, &by_agent, Some("k1"), Some("a1"));
        assert_eq!(got.as_deref(), Some("sid-agent"));
    }

    #[test]
    fn ignores_orphan_session_key_when_by_id_missing() {
        // by_session_key には残っているが、by_id 側で session が消えているケース。
        // attach できないので None を返す。
        let by_id = HashSet::new();
        let mut by_session_key = HashMap::new();
        by_session_key.insert("k1".to_string(), "sid-dead".to_string());
        let by_agent = HashMap::new();

        let got = lookup_attach(&by_id, &by_session_key, &by_agent, Some("k1"), None);
        assert!(got.is_none());
    }

    #[test]
    fn returns_none_when_neither_match() {
        let by_id = HashSet::new();
        let by_session_key = HashMap::new();
        let by_agent = HashMap::new();
        let got = lookup_attach(&by_id, &by_session_key, &by_agent, Some("k1"), Some("a1"));
        assert!(got.is_none());
    }

    #[test]
    fn returns_none_when_both_inputs_none() {
        let by_id = HashSet::new();
        let by_session_key = HashMap::new();
        let by_agent = HashMap::new();
        let got = lookup_attach(&by_id, &by_session_key, &by_agent, None, None);
        assert!(got.is_none());
    }
}

use super::{recover, SessionRegistry};
use crate::pty::session::{RegistrationLatch, SessionHandle};
use std::sync::Arc;

impl SessionRegistry {
    /// exit watcher 自身の handle が現在の entry と同一の場合だけ削除する。
    pub fn remove_if_same(
        &self,
        id: &str,
        registration: &Arc<RegistrationLatch>,
    ) -> Option<Arc<SessionHandle>> {
        let removed = {
            let mut inner = recover(self.inner.lock());
            let is_same = inner
                .by_id
                .get(id)
                .is_some_and(|handle| Arc::ptr_eq(&handle.registration, registration));
            if !is_same {
                return None;
            }
            let handle = inner.by_id.remove(id)?;
            if let Some(agent_id) = &handle.agent_id {
                if inner.by_agent.get(agent_id).map(String::as_str) == Some(id) {
                    inner.by_agent.remove(agent_id);
                }
            }
            if let Some(session_key) = &handle.session_key {
                if inner.by_session_key.get(session_key).map(String::as_str) == Some(id) {
                    inner.by_session_key.remove(session_key);
                }
            }
            handle
        };
        let _ = removed.kill();
        removed.cleanup_codex_broker_after_kill();
        Some(removed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty::session::test_support::handle_with;
    use std::sync::atomic::AtomicUsize;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn watcher_waits_until_registry_insert_completes_then_removes_own_handle() {
        let registry = Arc::new(SessionRegistry::new());
        let handle = handle_with(None, None, None, Arc::new(AtomicUsize::new(0)));
        let registration = handle.registration.clone();
        let registry_for_watcher = registry.clone();
        let registration_for_watcher = registration.clone();
        let (done_tx, done_rx) = mpsc::channel();

        std::thread::spawn(move || {
            let adopted = registration_for_watcher.wait_until_registered();
            let removed = adopted
                && registry_for_watcher
                    .remove_if_same("instant-exit", &registration_for_watcher)
                    .is_some();
            done_tx.send(removed).unwrap();
        });

        assert!(done_rx.recv_timeout(Duration::from_millis(20)).is_err());
        assert!(registry
            .insert_if_absent("instant-exit".to_string(), handle)
            .is_ok());
        assert_eq!(done_rx.recv_timeout(Duration::from_secs(1)), Ok(true));
        assert!(registry.get("instant-exit").is_none());
    }

    #[test]
    fn stale_watcher_cannot_remove_different_handle_with_same_id() {
        let registry = SessionRegistry::new();
        let current = handle_with(None, None, None, Arc::new(AtomicUsize::new(0)));
        let current_registration = current.registration.clone();
        let stale = handle_with(None, None, None, Arc::new(AtomicUsize::new(0)));
        let stale_registration = stale.registration.clone();

        assert!(registry
            .insert_if_absent("shared-id".into(), current)
            .is_ok());
        assert!(registry
            .remove_if_same("shared-id", &stale_registration)
            .is_none());
        assert!(registry.get("shared-id").is_some());
        assert!(registry
            .remove_if_same("shared-id", &current_registration)
            .is_some());
    }

    #[test]
    fn rejected_collision_unblocks_watcher_without_removing_current_entry() {
        let registry = SessionRegistry::new();
        let current = handle_with(None, None, None, Arc::new(AtomicUsize::new(0)));
        let rejected = handle_with(None, None, None, Arc::new(AtomicUsize::new(0)));
        let rejected_registration = rejected.registration.clone();

        assert!(registry
            .insert_if_absent("collision".into(), current)
            .is_ok());
        assert!(registry
            .insert_if_absent("collision".into(), rejected)
            .is_err());
        assert!(!rejected_registration.wait_until_registered());
        assert!(registry.get("collision").is_some());
    }

    #[test]
    fn dropping_pending_handle_rejects_registration_and_unblocks_watcher() {
        let handle = handle_with(None, None, None, Arc::new(AtomicUsize::new(0)));
        let registration = handle.registration.clone();
        let registration_for_watcher = registration.clone();
        let (done_tx, done_rx) = mpsc::channel();

        std::thread::spawn(move || {
            done_tx
                .send(registration_for_watcher.wait_until_registered())
                .unwrap();
        });

        assert!(done_rx.recv_timeout(Duration::from_millis(20)).is_err());
        drop(handle);
        assert_eq!(done_rx.recv_timeout(Duration::from_secs(1)), Ok(false));
    }
}

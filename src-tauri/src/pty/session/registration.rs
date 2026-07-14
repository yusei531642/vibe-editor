use std::sync::{Condvar, Mutex};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RegistrationState {
    Pending,
    Registered,
    Rejected,
}

/// exit watcher と registry insert の順序を同期する one-shot latch。
pub(crate) struct RegistrationLatch {
    state: Mutex<RegistrationState>,
    ready: Condvar,
}

impl RegistrationLatch {
    pub(super) fn new() -> Self {
        Self {
            state: Mutex::new(RegistrationState::Pending),
            ready: Condvar::new(),
        }
    }

    pub(crate) fn mark_registered(&self) {
        self.set(RegistrationState::Registered);
    }

    pub(crate) fn mark_rejected(&self) {
        self.set(RegistrationState::Rejected);
    }

    fn set(&self, state: RegistrationState) {
        let mut current = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if *current == RegistrationState::Pending {
            *current = state;
            self.ready.notify_all();
        }
    }

    pub(crate) fn wait_until_registered(&self) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        while *state == RegistrationState::Pending {
            state = self.ready.wait(state).unwrap_or_else(|e| e.into_inner());
        }
        *state == RegistrationState::Registered
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registration_result_is_first_writer_wins() {
        let registered = RegistrationLatch::new();
        registered.mark_registered();
        registered.mark_rejected();
        assert!(registered.wait_until_registered());

        let rejected = RegistrationLatch::new();
        rejected.mark_rejected();
        rejected.mark_registered();
        assert!(!rejected.wait_until_registered());
    }
}

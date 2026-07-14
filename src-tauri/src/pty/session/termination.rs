use std::sync::Mutex;
use super::SessionHandle;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminationReason {
    UserClose,
    TeamCleanup,
    AppShutdown,
    IdCollision,
}

impl TerminationReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UserClose => "user_close",
            Self::TeamCleanup => "team_cleanup",
            Self::AppShutdown => "app_shutdown",
            Self::IdCollision => "id_collision",
        }
    }
}

#[derive(Default)]
pub(super) struct TerminationState(Mutex<Option<TerminationReason>>);

impl TerminationState {
    /// 最初の明示終了だけを採用し、後続 cleanup が原因を上書きしない。
    pub(super) fn request(&self, reason: TerminationReason) -> bool {
        let mut current = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if current.is_some() {
            return false;
        }
        *current = Some(reason);
        true
    }

    pub(super) fn get(&self) -> Option<TerminationReason> {
        *self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl SessionHandle {
    pub fn request_termination(&self, reason: TerminationReason) {
        if self.termination.request(reason) {
            tracing::info!(
                reason = reason.as_str(),
                agent_id = ?self.agent_id,
                team_id = ?self.team_id,
                "[pty] termination requested"
            );
        }
    }

}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_writer_wins() {
        let state = TerminationState::default();
        assert!(state.request(TerminationReason::UserClose));
        assert!(!state.request(TerminationReason::AppShutdown));
        assert_eq!(state.get(), Some(TerminationReason::UserClose));
    }
}

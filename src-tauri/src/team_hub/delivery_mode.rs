//! vibe-team delivery mode switch.
//!
//! Issue #860: Monitor inbox delivery is opt-in while PTY injection remains the default.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeliveryMode {
    Pty,
    Monitor,
    Both,
}

impl DeliveryMode {
    pub fn from_env() -> Self {
        match std::env::var("VIBE_TEAM_DELIVERY_MODE")
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "monitor" | "inbox" | "agmsg" => Self::Monitor,
            "both" | "dual" => Self::Both,
            _ => Self::Pty,
        }
    }

    pub fn env_value_for_child(self) -> Option<&'static str> {
        match self {
            Self::Pty => None,
            Self::Monitor => Some("monitor"),
            Self::Both => Some("both"),
        }
    }

    pub fn should_skip_pty_inject(self) -> bool {
        matches!(self, Self::Monitor)
    }

    pub fn should_install_monitor_hook(self) -> bool {
        matches!(self, Self::Monitor | Self::Both)
    }
}

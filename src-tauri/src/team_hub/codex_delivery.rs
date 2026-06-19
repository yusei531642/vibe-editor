//! Issue #1068: codex への `team_send` 配送方式 (PTY 注入 / backend app-server) のユーザー設定を
//! team_hub から参照するためのプロセス内ミラー。
//!
//! team_hub はランタイム設定を環境変数から読む設計 (`delivery_mode.rs` 参照) で、永続 Settings を
//! 直接読まない。そこで `commands::settings` の `settings_load` / `settings_save` がこのアトミックな
//! ミラーを更新し、`deliver.rs` がここを見て分岐する。settings.json を Single Source of Truth とし、
//! 本ミラーはその読み取り専用キャッシュにすぎない。

use std::sync::atomic::{AtomicU8, Ordering};

/// codex `team_send` の配送方式。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CodexDelivery {
    /// app-server (JSON-RPC) が使えれば app-server、ダメなら PTY 注入へ fallback (既定)。
    Backend,
    /// 常に従来の PTY bracketed-paste 注入を使う。
    Pty,
}

impl CodexDelivery {
    fn as_u8(self) -> u8 {
        match self {
            Self::Backend => 0,
            Self::Pty => 1,
        }
    }

    fn from_u8(v: u8) -> Self {
        match v {
            1 => Self::Pty,
            _ => Self::Backend,
        }
    }
}

/// settings.json 由来の文字列を配送方式に解釈する。
/// `"pty"` のみ PTY 強制。未知値 / 空 / `None` は既定の `Backend` (= 現挙動維持)。
pub fn parse(value: Option<&str>) -> CodexDelivery {
    match value.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("pty") => CodexDelivery::Pty,
        _ => CodexDelivery::Backend,
    }
}

/// 既定は `Backend` (= app-server 優先、現挙動維持)。
static PREF: AtomicU8 = AtomicU8::new(0);

/// settings の `codexTeamSendDelivery` をミラーへ反映する。
pub fn set_from_settings(value: Option<&str>) {
    PREF.store(parse(value).as_u8(), Ordering::Relaxed);
}

/// 現在の配送方式。
pub fn current() -> CodexDelivery {
    CodexDelivery::from_u8(PREF.load(Ordering::Relaxed))
}

/// PTY 注入を強制する設定か。`deliver.rs` の分岐で使う。
pub fn prefers_pty() -> bool {
    current() == CodexDelivery::Pty
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_maps_known_and_unknown_values() {
        assert_eq!(parse(Some("pty")), CodexDelivery::Pty);
        assert_eq!(parse(Some("PTY")), CodexDelivery::Pty);
        assert_eq!(parse(Some("  pty  ")), CodexDelivery::Pty);
        assert_eq!(parse(Some("backend")), CodexDelivery::Backend);
        // 未知値 / 空 / None はすべて既定の Backend にフォールバックする。
        assert_eq!(parse(Some("app-server")), CodexDelivery::Backend);
        assert_eq!(parse(Some("")), CodexDelivery::Backend);
        assert_eq!(parse(None), CodexDelivery::Backend);
    }

    #[test]
    fn set_from_settings_roundtrips_through_mirror() {
        set_from_settings(Some("pty"));
        assert!(prefers_pty());
        assert_eq!(current(), CodexDelivery::Pty);

        set_from_settings(Some("backend"));
        assert!(!prefers_pty());
        assert_eq!(current(), CodexDelivery::Backend);

        // 未知 / None は Backend へ戻る。
        set_from_settings(None);
        assert!(!prefers_pty());
    }
}

// Issue #342 Phase 1 / Phase 3 + Issue #493: Hub レベルの構造化エラー型。
//
// 旧 `RecruitError` / `ToolError` (各 MCP tool が `Err(String)` に詰める前段の構造化エラー) は
// Issue #493 で `team_hub/protocol/tools/error.rs` に移動した。本ファイルには
// recruit ack lifecycle / pending 管理の内部診断用 enum のみを残す。

/// `app_recruit_ack` invoke で renderer から渡される失敗 phase。
///
/// 任意文字列を受けると log injection / 偽装の余地が出るので、enum で受け側が固定する。
/// renderer 側の文字列 `phase` を `from_str` でこの enum に正規化し、未知値は弾く。
#[derive(Clone, Copy, Debug)]
pub enum AckFailPhase {
    Spawn,
    EngineBinaryMissing,
    InstructionsLoad,
    RequesterNotFound,
}

impl AckFailPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Spawn => "spawn",
            Self::EngineBinaryMissing => "engine_binary_missing",
            Self::InstructionsLoad => "instructions_load",
            Self::RequesterNotFound => "requester_not_found",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "spawn" => Some(Self::Spawn),
            "engine_binary_missing" => Some(Self::EngineBinaryMissing),
            "instructions_load" => Some(Self::InstructionsLoad),
            "requester_not_found" => Some(Self::RequesterNotFound),
            _ => None,
        }
    }
}

/// `resolve_recruit_ack` の失敗種別 (内部診断用)。
/// renderer 信頼境界違反 / 競合 ack のいずれも MCP caller に対しては no-op + warn ログで吸収するため、
/// このエラーは Tauri command 層では握り潰されてログにだけ出す。
#[derive(Debug)]
pub enum AckError {
    /// `pending_recruits` に該当 agent_id が無い (cancel 後 / 偽装)
    NotFound,
    /// pending の team_id と expected_team_id が一致しない (cross-team 偽 cancel 試行)
    TeamMismatch,
    /// 既に ack 済み (重複呼び出し)
    AlreadyAcked,
}

impl std::fmt::Display for AckError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound => write!(f, "no pending recruit for agent_id"),
            Self::TeamMismatch => write!(f, "team_id mismatch with pending recruit"),
            Self::AlreadyAcked => write!(f, "recruit already acked"),
        }
    }
}

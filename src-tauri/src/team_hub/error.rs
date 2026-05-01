// Issue #342 Phase 1 / Phase 3: 構造化エラー型。
//
// MCP の各ツール失敗を呼び出し側 (renderer / Claude / Codex) が `code` で機械的に
// 分岐できるように、`result.content[0].text` の JSON 文字列内に詰める形で返す。
// Phase 1 で `RecruitError` を追加し、Phase 3 (3.9) で `DismissError` / `SendError` /
// `AssignError` を `ToolError` 共通型 + 型エイリアスで横展開した。
// すべて `code` / `message` / `phase` / `elapsed_ms` の 4 フィールド共通形。

use serde::Serialize;

/// `team_recruit` 失敗時に MCP 戻り値へ詰める構造化エラー。
///
/// シリアライズ後の例:
/// ```json
/// {"code":"recruit_ack_timeout","message":"...","phase":"ack","elapsed_ms":5012}
/// ```
#[derive(Clone, Debug, Serialize)]
pub struct RecruitError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<u64>,
}

impl std::fmt::Display for RecruitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl RecruitError {
    /// JSON 文字列化して `Err(String)` に詰めるヘルパ。
    /// to_string() に失敗したら message だけを返す (生 String fallback)。
    pub fn into_err_string(self) -> String {
        match serde_json::to_string(&self) {
            Ok(s) => s,
            Err(_) => self.message,
        }
    }
}

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

/// Issue #342 Phase 3 (3.9): `team_dismiss` / `team_send` / `team_assign_task` の構造化エラー
/// 共通型。`RecruitError` と同形 (code / message / phase / elapsed_ms) で、JSON 化してから
/// `Err(String)` に詰めて MCP `result.content[0].text` のオブジェクト値として返す。
///
/// 呼び出し側は `code` で機械的に分岐できる:
///   - `dismiss_*` (例: `dismiss_permission_denied`, `dismiss_not_found`)
///   - `send_*`    (例: `send_payload_too_large`, `send_invalid_args`)
///   - `assign_*`  (例: `assign_permission_denied`, `assign_unknown_assignee`)
#[derive(Clone, Debug, Serialize)]
pub struct ToolError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<u64>,
}

impl std::fmt::Display for ToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl ToolError {
    pub fn into_err_string(self) -> String {
        match serde_json::to_string(&self) {
            Ok(s) => s,
            Err(_) => self.message,
        }
    }
}

/// `team_dismiss` 失敗用 (code 名前空間 `dismiss_*`)
pub type DismissError = ToolError;
/// `team_send` 失敗用 (code 名前空間 `send_*`)
pub type SendError = ToolError;
/// `team_assign_task` 失敗用 (code 名前空間 `assign_*`)
pub type AssignError = ToolError;

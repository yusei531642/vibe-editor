//! Issue #342 Phase 1 / Phase 3 + Issue #493: 各 MCP tool が Err 経路で返す構造化エラー型。
//!
//! MCP の各ツール失敗を呼び出し側 (renderer / Claude / Codex) が `code` で機械的に
//! 分岐できるように、`result.content[0].text` の JSON 文字列内に詰める形で返す。
//! Phase 1 で `RecruitError` を導入、Phase 3 (3.9) で `DismissError` / `SendError` /
//! `AssignError` を `ToolError` 共通型 + 型エイリアスで横展開。
//! Issue #493: 旧 `team_hub/error.rs` から移動して各 tool 専用の error 構成と
//! 共通 helper (`permission_denied` / `invalid_args` / `with_phase` / `with_elapsed_ms`) を集約。
//!
//! `Serialize` 出力は全 tool 共通で **flat JSON** (`{"code": "...", "message": "...",
//! "phase": "...", "elapsed_ms": 1234}`)。renderer 側は `code` 文字列から `recruit_*` /
//! `dismiss_*` / `send_*` / `assign_*` / `ack_handoff_*` / `create_leader_*` /
//! `switch_leader_*` の名前空間で機械的に分岐できる。
//!
//! 各 tool は型エイリアス (`RecruitError = ToolError` 等) を import するだけで、
//! 既存の struct-literal による組み立て (`ToolError { code, message, phase, elapsed_ms }`)
//! と新しい helper 経由のどちらでも同じ flat JSON を出力する。

use serde::Serialize;

/// 全 MCP tool が `Err(String)` に詰める前段に通す共通エラー型。
///
/// payload 後方互換のため flat JSON シリアライズを維持。
/// `#[non_exhaustive]` は将来 (例: `caused_by` chain や `caller_agent_id` 等) のフィールド追加で
/// 既存 caller を破壊しないためのマーカー。同 crate 内の struct-literal 構築は引き続き許可。
#[non_exhaustive]
#[derive(Clone, Debug, Serialize)]
pub struct ToolError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<u64>,
}

impl ToolError {
    /// 任意 code / message でインスタンス化。`with_phase` / `with_elapsed_ms` で追加情報を載せる。
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            phase: None,
            elapsed_ms: None,
        }
    }

    /// "permission denied: role 'X' cannot {action}" 形のエラーを 1 行で組み立てる。
    /// `code_prefix` は tool ごとの命名空間 (例: `"recruit"` / `"dismiss"`)、結果 code は
    /// `{code_prefix}_permission_denied` になる。
    pub fn permission_denied(code_prefix: &str, role: &str, action: &str) -> Self {
        Self::new(
            format!("{code_prefix}_permission_denied"),
            format!("permission denied: role '{role}' cannot {action}"),
        )
    }

    /// "{message}" + `code = {code_prefix}_invalid_args` の不正引数エラー。
    pub fn invalid_args(code_prefix: &str, message: impl Into<String>) -> Self {
        Self::new(format!("{code_prefix}_invalid_args"), message)
    }

    /// 失敗 phase ("ack" / "handshake" / "spawn" 等) を後付けする builder。
    pub fn with_phase(mut self, phase: impl Into<String>) -> Self {
        self.phase = Some(phase.into());
        self
    }

    /// 経過ミリ秒を後付けする builder (timeout 等の調査に使う)。
    pub fn with_elapsed_ms(mut self, ms: u64) -> Self {
        self.elapsed_ms = Some(ms);
        self
    }

    /// Issue #737: dispatcher が `{"error": ...}` に詰めるための JSON 値化。
    /// flat object へのシリアライズに失敗した場合は message 文字列値へ degrade する
    /// (旧 `into_err_string` の生 String fallback と等価の安全策)。
    pub fn to_json_value(&self) -> serde_json::Value {
        serde_json::to_value(self)
            .unwrap_or_else(|_| serde_json::Value::String(self.message.clone()))
    }
}

/// Issue #737: MCP tool を `Result<Value, ToolError>` に統一したことで、`?` で
/// 伝播してくる `String` エラー (例: `record_handoff_lifecycle` / `acquire_recruit_permit`
/// 等、tool ではない hub 内部関数が返す `Result<_, String>`) を `ToolError` に持ち上げる。
/// tool 固有の code 名前空間を持たない内部エラーなので、generic な `tool_error` code で包む。
/// message 文字列はそのまま保持するため、呼び出し側が受け取る情報量は従来と変わらない。
impl From<String> for ToolError {
    fn from(message: String) -> Self {
        Self::new("tool_error", message)
    }
}

impl From<&str> for ToolError {
    fn from(message: &str) -> Self {
        Self::new("tool_error", message.to_string())
    }
}

impl std::fmt::Display for ToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

/// `team_recruit` / `team_create_leader` 失敗用 (code 名前空間 `recruit_*` / `create_leader_*`)。
/// flat JSON 出力は `ToolError` と完全同一。
pub type RecruitError = ToolError;
/// `team_dismiss` 失敗用 (code 名前空間 `dismiss_*`)。
pub type DismissError = ToolError;
/// `team_send` 失敗用 (code 名前空間 `send_*`)。
pub type SendError = ToolError;
/// `team_assign_task` 失敗用 (code 名前空間 `assign_*`)。
pub type AssignError = ToolError;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flat_json_payload_is_preserved() {
        let err = ToolError::new("dismiss_permission_denied", "permission denied: role 'planner' cannot dismiss");
        // Issue #737: dispatcher は `to_json_value()` で flat object を取り出す。
        let value = err.to_json_value();
        // 旧 RecruitError / ToolError と同じ flat shape (`{"code":"...","message":"..."}`)。
        assert_eq!(value["code"], "dismiss_permission_denied");
        assert_eq!(
            value["message"],
            "permission denied: role 'planner' cannot dismiss"
        );
        // optional フィールドは skip_serializing_if で省略 (object に key 自体が無い)。
        let obj = value.as_object().expect("flat object");
        assert!(!obj.contains_key("phase"));
        assert!(!obj.contains_key("elapsed_ms"));
    }

    /// Issue #737: tool ではない hub 内部関数が返す `String` エラーは generic な
    /// `tool_error` code で包まれる。message 文字列はそのまま保持される。
    #[test]
    fn from_string_wraps_with_generic_code() {
        let err: ToolError = "project_root is not registered for this team".to_string().into();
        assert_eq!(err.code, "tool_error");
        assert_eq!(err.message, "project_root is not registered for this team");
        assert!(err.phase.is_none());
    }

    #[test]
    fn permission_denied_helper_produces_canonical_message() {
        let err = ToolError::permission_denied("recruit", "planner", "recruit");
        assert_eq!(err.code, "recruit_permission_denied");
        assert_eq!(err.message, "permission denied: role 'planner' cannot recruit");
        assert!(err.phase.is_none());
        assert!(err.elapsed_ms.is_none());
    }

    #[test]
    fn invalid_args_helper_uses_code_prefix() {
        let err = ToolError::invalid_args("send", "to and message are required");
        assert_eq!(err.code, "send_invalid_args");
        assert_eq!(err.message, "to and message are required");
    }

    #[test]
    fn with_phase_and_elapsed_chain() {
        let err = ToolError::new("recruit_handshake_timeout", "agent did not handshake within 30s")
            .with_phase("handshake")
            .with_elapsed_ms(30_004);
        assert_eq!(err.phase.as_deref(), Some("handshake"));
        assert_eq!(err.elapsed_ms, Some(30_004));
    }

    #[test]
    fn type_aliases_are_same_type() {
        // RecruitError / DismissError / SendError / AssignError は全て ToolError の alias で、
        // 同じ struct-literal で構築でき、同じ flat JSON にシリアライズされる。
        let dismiss: DismissError = ToolError::new("dismiss_not_found", "...");
        let recruit: RecruitError = ToolError::new("recruit_failed", "...");
        let send: SendError = ToolError::new("send_payload_too_large", "...");
        let assign: AssignError = ToolError::new("assign_unknown_assignee", "...");
        // 型として全て同一なので `Vec<ToolError>` に詰められる。
        let _all: Vec<ToolError> = vec![dismiss, recruit, send, assign];
    }
}

//! Centralized error type for IPC commands.
//!
//! Issue #931: `Serialize` impl は `{ code, message }` の構造化オブジェクトを返す。
//! renderer 側は `tauri-api/command-error.ts` の `invokeCommand()` が reject 値を
//! `CommandError` (code / message を必ず持つ Error subclass) に正規化する契約。
//! 失敗理由の機械判別は **code フィールドのみ** で行い、message (人間向け表示文字列)
//! への `includes` / `===` / `startsWith` 分岐を書かないこと (#888 の dead branch の轍)。
//!
//! 旧契約 (message 文字列のみ serialize + JSON-in-string ハック) は #737 の部分適用で
//! 止まっていたもので、本 PR で正式フィールドに昇格した。
use serde::ser::{Serialize, SerializeStruct, Serializer};
use std::fmt;

#[derive(Debug)]
pub enum CommandError {
    Io(String),
    Parse(String),
    Validation(String),
    NotFound(String),
    Internal(String),
    /// Issue #600 (Tier A-2): authorization 失敗 (例: renderer から渡された project_root が
    /// active project_root と一致しないなど cross-project leak の阻止)。
    Authz(String),
    /// Issue #931: variant 分類より細かい machine-readable code を明示したいエラー
    /// (旧 `{"code":"...","message":"..."}` JSON-in-string ハックの後継)。
    /// code は `snake_case` の安定識別子 (例: `retry_unknown_team`)。
    Coded { code: String, message: String },
}

impl CommandError {
    pub fn validation(message: impl Into<String>) -> Self {
        Self::Validation(message.into())
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::NotFound(message.into())
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::Internal(message.into())
    }

    /// Issue #600: cross-project access の reject 等 authorization 失敗用。
    pub fn authz(message: impl Into<String>) -> Self {
        Self::Authz(message.into())
    }

    /// Issue #931: 明示 code 付きエラー。renderer は `err.code` で分岐する。
    pub fn coded(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Coded {
            code: code.into(),
            message: message.into(),
        }
    }

    /// IPC 境界を越える machine-readable な失敗分類。
    /// renderer (`command-error.ts`) はこの値を `CommandError.code` として公開する。
    pub fn code(&self) -> &str {
        match self {
            Self::Io(_) => "io",
            Self::Parse(_) => "parse",
            Self::Validation(_) => "validation",
            Self::NotFound(_) => "not_found",
            Self::Internal(_) => "internal",
            Self::Authz(_) => "authz",
            Self::Coded { code, .. } => code,
        }
    }

    fn message(&self) -> &str {
        match self {
            Self::Io(message)
            | Self::Parse(message)
            | Self::Validation(message)
            | Self::NotFound(message)
            | Self::Internal(message)
            | Self::Authz(message)
            | Self::Coded { message, .. } => message,
        }
    }
}

impl fmt::Display for CommandError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for CommandError {}

impl Serialize for CommandError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        // Issue #931: `{ code, message }` の構造化オブジェクト。renderer 側の
        // `CommandError.from()` は object 形を最優先で解釈する (旧 string 形も
        // 後方互換で parse できるが、新規コードは必ずこの形で返す)。
        let mut s = serializer.serialize_struct("CommandError", 2)?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", self.message())?;
        s.end()
    }
}

impl From<anyhow::Error> for CommandError {
    fn from(value: anyhow::Error) -> Self {
        Self::Internal(format!("{value:#}"))
    }
}

impl From<std::io::Error> for CommandError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value.to_string())
    }
}

impl From<serde_json::Error> for CommandError {
    fn from(value: serde_json::Error) -> Self {
        Self::Parse(value.to_string())
    }
}

impl From<String> for CommandError {
    fn from(value: String) -> Self {
        Self::Internal(value)
    }
}

impl From<&str> for CommandError {
    fn from(value: &str) -> Self {
        Self::Internal(value.to_string())
    }
}

impl From<CommandError> for String {
    fn from(value: CommandError) -> Self {
        value.to_string()
    }
}

pub type CommandResult<T> = Result<T, CommandError>;

//! Centralized error type for IPC commands.
//!
//! Renderer 側 (`src/renderer/src/lib/tauri-api.ts`) は `Err` payload を string として
//! 受け取り続ける必要があるため、`Serialize` impl は意図的に variant tag を含めず
//! `message` のみをシリアライズする。新規 variant を追加する際は同じ契約を維持すること。
use serde::ser::{Serialize, Serializer};
use std::fmt;

#[derive(Debug)]
pub enum CommandError {
    Io(String),
    Parse(String),
    Validation(String),
    NotFound(String),
    Internal(String),
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

    fn message(&self) -> &str {
        match self {
            Self::Io(message)
            | Self::Parse(message)
            | Self::Validation(message)
            | Self::NotFound(message)
            | Self::Internal(message) => message,
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
        // 既存 IPC の Err payload は文字列だったため、互換性を優先して message のみ返す。
        serializer.serialize_str(self.message())
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

use crate::pty::UserWriteOutcome;
use crate::state::AppState;
use serde::Serialize;
use tauri::State;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TerminalWriteOutcome {
    Written,
    SuppressedInjecting,
    DroppedTooLarge,
    DroppedRateLimited,
    SessionNotFound,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalWriteResult {
    pub outcome: TerminalWriteOutcome,
}

impl From<UserWriteOutcome> for TerminalWriteOutcome {
    fn from(value: UserWriteOutcome) -> Self {
        match value {
            UserWriteOutcome::Written => Self::Written,
            UserWriteOutcome::SuppressedInjecting => Self::SuppressedInjecting,
            UserWriteOutcome::DroppedTooLarge => Self::DroppedTooLarge,
            UserWriteOutcome::DroppedRateLimited => Self::DroppedRateLimited,
        }
    }
}

#[tauri::command]
pub async fn terminal_write(
    state: State<'_, AppState>,
    id: String,
    data: String,
) -> crate::commands::error::CommandResult<TerminalWriteResult> {
    let Some(session) = state.pty_registry.get(&id) else {
        return Ok(TerminalWriteResult {
            outcome: TerminalWriteOutcome::SessionNotFound,
        });
    };
    let data_len = data.len();
    let outcome = tokio::task::spawn_blocking(move || session.user_write(data.as_bytes()))
        .await
        .map_err(|error| {
            format!("[terminal] terminal_write spawn_blocking failed for {id}: {error}")
        })?
        .map_err(|error| error.to_string())?;
    match outcome {
        UserWriteOutcome::Written | UserWriteOutcome::SuppressedInjecting => {}
        UserWriteOutcome::DroppedTooLarge => tracing::warn!(
            "[terminal] dropped oversized terminal_write payload for {id}: {data_len} bytes"
        ),
        UserWriteOutcome::DroppedRateLimited => {
            tracing::warn!("[terminal] rate-limited terminal_write for {id}: {data_len} bytes")
        }
    }
    Ok(TerminalWriteResult {
        outcome: outcome.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_all_internal_write_outcomes_to_ipc_contract() {
        let cases = [
            (UserWriteOutcome::Written, TerminalWriteOutcome::Written),
            (
                UserWriteOutcome::SuppressedInjecting,
                TerminalWriteOutcome::SuppressedInjecting,
            ),
            (
                UserWriteOutcome::DroppedTooLarge,
                TerminalWriteOutcome::DroppedTooLarge,
            ),
            (
                UserWriteOutcome::DroppedRateLimited,
                TerminalWriteOutcome::DroppedRateLimited,
            ),
        ];
        for (internal, expected) in cases {
            assert_eq!(TerminalWriteOutcome::from(internal), expected);
        }
    }

    #[test]
    fn serializes_write_outcomes_as_camel_case_strings() {
        assert_eq!(
            serde_json::to_string(&TerminalWriteOutcome::SuppressedInjecting).unwrap(),
            r#""suppressedInjecting""#
        );
        assert_eq!(
            serde_json::to_string(&TerminalWriteOutcome::SessionNotFound).unwrap(),
            r#""sessionNotFound""#
        );
    }
}

use crate::commands::error::{CommandError, CommandResult};

pub(super) fn map_session_delete_result(result: std::io::Result<()>) -> CommandResult<()> {
    match result {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(CommandError::Io(error.to_string())),
    }
}

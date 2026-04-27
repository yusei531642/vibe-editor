use std::path::PathBuf;

use tokio::io::{AsyncReadExt, AsyncSeekExt};

pub const LOG_FILE_NAME: &str = "vibe-editor.log";
pub const DEFAULT_LOG_READ_BYTES: u64 = 256 * 1024;
const MIN_LOG_READ_BYTES: u64 = 16 * 1024;
const MAX_LOG_READ_BYTES: u64 = 2 * 1024 * 1024;

pub fn log_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".vibe-editor")
        .join("logs")
}

pub fn log_path() -> PathBuf {
    log_dir().join(LOG_FILE_NAME)
}

pub async fn read_tail(max_bytes: Option<u64>) -> Result<(String, bool, u64, bool), String> {
    let max_bytes = max_bytes
        .unwrap_or(DEFAULT_LOG_READ_BYTES)
        .clamp(MIN_LOG_READ_BYTES, MAX_LOG_READ_BYTES);
    let path = log_path();
    let metadata = match tokio::fs::metadata(&path).await {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok((String::new(), false, max_bytes, false));
        }
        Err(err) => return Err(err.to_string()),
    };

    let len = metadata.len();
    let start = len.saturating_sub(max_bytes);
    let truncated = start > 0;
    let mut file = tokio::fs::File::open(&path)
        .await
        .map_err(|err| err.to_string())?;
    if start > 0 {
        file.seek(std::io::SeekFrom::Start(start))
            .await
            .map_err(|err| err.to_string())?;
    }
    let mut bytes = Vec::with_capacity((len - start).min(max_bytes) as usize);
    file.read_to_end(&mut bytes)
        .await
        .map_err(|err| err.to_string())?;
    Ok((
        String::from_utf8_lossy(&bytes).into_owned(),
        true,
        max_bytes,
        truncated,
    ))
}

pub async fn clear() -> Result<(), String> {
    tokio::fs::create_dir_all(log_dir())
        .await
        .map_err(|err| err.to_string())?;
    tokio::fs::write(log_path(), b"")
        .await
        .map_err(|err| err.to_string())
}

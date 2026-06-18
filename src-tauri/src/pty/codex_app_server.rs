//! Issue #1062: Codex app-server daemon の control socket 検出。
//!
//! `team_send` の app-server 配送は、Codex の thread id に加えて daemon の control socket が
//! 必要になる。ここでは Codex PTY 起動時に daemon を best-effort で起動し、利用可能な
//! unix socket path だけを `SessionHandle` に渡す。失敗時は None に倒し、従来の PTY 注入へ
//! フォールバックさせる。

#[cfg(unix)]
use std::path::{Path, PathBuf};
use std::sync::Mutex;
#[cfg(unix)]
use std::time::Duration;

use crate::pty::session::SessionHandle;
#[cfg(unix)]
use crate::util::log_redact::redact_home;

#[cfg(unix)]
const DAEMON_START_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(unix)]
const SOCKET_WAIT_TIMEOUT: Duration = Duration::from_secs(2);
#[cfg(unix)]
const SOCKET_POLL_INTERVAL: Duration = Duration::from_millis(100);

#[cfg(unix)]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DaemonStartResponse {
    socket_path: Option<String>,
}

pub async fn prepare_for_terminal(
    codex_command: &str,
    is_codex: bool,
    team_id: Option<&str>,
    agent_id: Option<&str>,
) -> Option<String> {
    if is_codex && team_id.is_some() && agent_id.is_some() {
        ensure_control_socket(codex_command).await
    } else {
        None
    }
}

pub fn target_for_session(session: &SessionHandle) -> Option<(String, String)> {
    if !session.is_codex {
        return None;
    }
    Some((
        clone_metadata(&session.app_server_socket, "app_server_socket")?,
        clone_metadata(&session.thread_id, "thread_id")?,
    ))
}

pub fn set_thread_id(session: &SessionHandle, thread_id: &str) {
    if !session.is_codex || thread_id.trim().is_empty() {
        return;
    }
    match session.thread_id.lock() {
        Ok(mut guard) => *guard = Some(thread_id.to_string()),
        Err(poisoned) => {
            tracing::warn!("[codex_app_server] thread_id mutex poisoned; recovering");
            *poisoned.into_inner() = Some(thread_id.to_string());
        }
    }
}

fn clone_metadata(lock: &Mutex<Option<String>>, name: &str) -> Option<String> {
    match lock.lock() {
        Ok(guard) => guard.clone(),
        Err(poisoned) => {
            tracing::warn!("[codex_app_server] {name} mutex poisoned; recovering");
            poisoned.into_inner().clone()
        }
    }
}

/// Codex app-server control socket を用意する。
///
/// Unix 以外では app-server 配送が未対応なので None を返す。
#[cfg(not(unix))]
pub async fn ensure_control_socket(_codex_command: &str) -> Option<String> {
    None
}

/// Codex app-server control socket を用意する。
#[cfg(unix)]
pub async fn ensure_control_socket(codex_command: &str) -> Option<String> {
    if codex_command.trim().is_empty() {
        return None;
    }

    if let Some(path) = default_control_socket_path() {
        if is_socket(&path) {
            return Some(path.to_string_lossy().into_owned());
        }
    }

    let mut cmd = tokio::process::Command::new(codex_command);
    cmd.args(["app-server", "daemon", "start"]);
    cmd.env("PATH", super::session::unix_path::enriched_path());

    let output = match tokio::time::timeout(DAEMON_START_TIMEOUT, cmd.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => {
            tracing::warn!(
                "[codex_app_server] failed to start daemon command={} error={e}",
                redact_home(codex_command)
            );
            return default_existing_socket_after_wait().await;
        }
        Err(_) => {
            tracing::warn!(
                "[codex_app_server] daemon start timed out command={}",
                redact_home(codex_command)
            );
            return default_existing_socket_after_wait().await;
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        tracing::warn!(
            "[codex_app_server] daemon start failed status={} stderr={}",
            output.status,
            stderr.trim()
        );
        return default_existing_socket_after_wait().await;
    }

    let parsed_socket = serde_json::from_slice::<DaemonStartResponse>(&output.stdout)
        .ok()
        .and_then(|r| r.socket_path)
        .map(PathBuf::from);

    wait_for_socket(parsed_socket.or_else(default_control_socket_path)).await
}

#[cfg(unix)]
async fn default_existing_socket_after_wait() -> Option<String> {
    wait_for_socket(default_control_socket_path()).await
}

#[cfg(unix)]
async fn wait_for_socket(path: Option<PathBuf>) -> Option<String> {
    let path = path?;
    let started = std::time::Instant::now();
    while started.elapsed() <= SOCKET_WAIT_TIMEOUT {
        if is_socket(&path) {
            let socket = path.to_string_lossy().into_owned();
            tracing::info!(
                "[codex_app_server] control socket ready path={}",
                redact_home(&socket)
            );
            return Some(socket);
        }
        tokio::time::sleep(SOCKET_POLL_INTERVAL).await;
    }
    tracing::warn!(
        "[codex_app_server] control socket not available path={}",
        redact_home(&path.to_string_lossy())
    );
    None
}

#[cfg(unix)]
fn default_control_socket_path() -> Option<PathBuf> {
    codex_home_dir().map(|home| {
        home.join("app-server-control")
            .join("app-server-control.sock")
    })
}

#[cfg(unix)]
fn codex_home_dir() -> Option<PathBuf> {
    std::env::var("CODEX_HOME")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))
}

#[cfg(unix)]
fn is_socket(path: &Path) -> bool {
    use std::os::unix::fs::FileTypeExt;
    std::fs::metadata(path)
        .map(|m| m.file_type().is_socket())
        .unwrap_or(false)
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use crate::pty::session::test_support;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;

    #[test]
    fn daemon_start_response_uses_camel_case_socket_path() {
        let parsed: DaemonStartResponse =
            serde_json::from_str(r#"{"status":"running","socketPath":"/tmp/codex.sock"}"#)
                .expect("parse daemon response");
        assert_eq!(parsed.socket_path.as_deref(), Some("/tmp/codex.sock"));
    }

    #[tokio::test]
    async fn prepare_for_terminal_skips_non_team_codex() {
        assert!(
            prepare_for_terminal("missing-codex", true, None, Some("agent"))
                .await
                .is_none()
        );
        assert!(
            prepare_for_terminal("missing-codex", true, Some("team"), None)
                .await
                .is_none()
        );
        assert!(
            prepare_for_terminal("missing-codex", false, Some("team"), Some("agent"))
                .await
                .is_none()
        );
    }

    #[test]
    fn target_for_session_requires_socket_and_thread_id() {
        let mut handle = test_support::handle_with(
            Some("agent"),
            None,
            Some("team"),
            Arc::new(AtomicUsize::new(0)),
        );
        handle.is_codex = true;
        assert!(target_for_session(&handle).is_none());

        *handle.app_server_socket.lock().unwrap() = Some("/tmp/codex.sock".to_string());
        assert!(target_for_session(&handle).is_none());

        set_thread_id(&handle, "thread-123");
        assert_eq!(
            target_for_session(&handle),
            Some(("/tmp/codex.sock".to_string(), "thread-123".to_string()))
        );
    }
}

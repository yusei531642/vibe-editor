use crate::pty::scrollback::scrollback_to_string;
use crate::pty::SessionRegistry;
use portable_pty::Child;
use std::sync::{mpsc::Receiver, Arc};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use super::exit_info::{normalize_exit_code, summarize_exit_tail, TerminalExitInfo};
use super::registration::RegistrationLatch;

/// 子プロセス終了後、採用された自分自身のregistry entryだけを回収してexitを通知する。
pub(super) fn spawn_exit_watcher(
    app: AppHandle,
    exit_event: String,
    id: String,
    mut child: Box<dyn Child + Send + Sync>,
    batcher_done: Receiver<()>,
    registry: Arc<SessionRegistry>,
    registration: Arc<RegistrationLatch>,
) {
    std::thread::spawn(move || {
        let exit_status = child.wait().ok();
        let removed = if registration.wait_until_registered() {
            registry.remove_if_same(&id, &registration)
        } else {
            None
        };
        let exit_record = removed.as_ref().and_then(|handle| {
            handle
                .team_id
                .clone()
                .zip(handle.agent_id.clone())
                .map(|(team_id, agent_id)| (team_id, agent_id, handle.scrollback.clone()))
        });
        // ConPTY は master drop 後に reader EOFとなるため、flush待機前にremovedをdropする。
        drop(removed);

        match batcher_done.recv_timeout(Duration::from_secs(2)) {
            Ok(()) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => tracing::warn!(
                "[pty] timed out waiting for final data flush before exit event: {exit_event}"
            ),
        }

        let output_tail = exit_record
            .as_ref()
            .and_then(|(_, _, scrollback)| scrollback_to_string(scrollback));
        let info = TerminalExitInfo {
            exit_code: exit_status
                .as_ref()
                .map(|status| normalize_exit_code(status.exit_code()))
                .unwrap_or(-1),
            signal: None,
            tail: summarize_exit_tail(output_tail.as_deref()),
        };
        if let Err(error) = app.emit(&exit_event, info.clone()) {
            tracing::warn!("emit {exit_event} failed: {error}");
        }
        if let Some((team_id, agent_id, _)) = exit_record {
            tauri::async_runtime::spawn(async move {
                let Some(state) = app.try_state::<crate::state::AppState>() else {
                    return;
                };
                state
                    .team_hub
                    .clone()
                    .record_agent_process_exit(&team_id, &agent_id, info.exit_code, output_tail)
                    .await;
            });
        }
    });
}

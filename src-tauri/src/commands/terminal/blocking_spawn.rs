use crate::pty::{spawn_session, SessionRegistry, SpawnOptions};
use std::sync::Arc;
use tauri::AppHandle;
use uuid::Uuid;

const MAX_ID_ATTEMPTS: usize = 3;

pub(super) async fn spawn_and_register(
    app: AppHandle,
    initial_id: String,
    spawn_opts: SpawnOptions,
    registry: Arc<SessionRegistry>,
) -> anyhow::Result<String> {
    tokio::task::spawn_blocking(move || {
        let mut id_candidate = initial_id;
        for attempt in 1..=MAX_ID_ATTEMPTS {
            let handle = spawn_session(
                app.clone(),
                id_candidate.clone(),
                spawn_opts.clone(),
                registry.clone(),
            )?;
            match registry.insert_if_absent(id_candidate.clone(), handle) {
                Ok(()) => return Ok(id_candidate),
                Err(returned_handle) => {
                    let _ = returned_handle.kill();
                    if attempt == MAX_ID_ATTEMPTS {
                        anyhow::bail!(
                            "terminal_create failed: id collision persisted after {attempt} attempts"
                        );
                    }
                    tracing::warn!(
                        "[terminal] id {id_candidate} collided in registry (attempt {attempt}/{MAX_ID_ATTEMPTS}), retrying with fresh UUID"
                    );
                    id_candidate = Uuid::new_v4().to_string();
                }
            }
        }
        unreachable!("bounded spawn attempts always return")
    })
    .await
    .map_err(|error| anyhow::anyhow!("terminal_create blocking spawn task failed: {error}"))?
}

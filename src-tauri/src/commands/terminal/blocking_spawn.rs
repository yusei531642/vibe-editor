use crate::commands::project_authority::ProjectRootIdentity;
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
    expected_cwd_identity: Option<ProjectRootIdentity>,
) -> anyhow::Result<String> {
    tokio::task::spawn_blocking(move || {
        let mut id_candidate = initial_id;
        for attempt in 1..=MAX_ID_ATTEMPTS {
            verify_spawn_cwd_identity(&spawn_opts.cwd, expected_cwd_identity.as_ref())?;
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

fn verify_spawn_cwd_identity(
    cwd: &str,
    expected: Option<&ProjectRootIdentity>,
) -> anyhow::Result<()> {
    let Some(expected) = expected else {
        return Ok(());
    };
    let observed = crate::commands::project_identity::capture_identity_blocking(cwd.into())
        .map_err(|error| anyhow::anyhow!("spawn cwd authorization failed: {error}"))?;
    if &observed != expected {
        anyhow::bail!("spawn cwd authorization failed: directory identity changed before spawn");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::verify_spawn_cwd_identity;
    use tempfile::tempdir;

    #[tokio::test]
    async fn replaced_authorized_cwd_is_rejected_at_blocking_spawn_boundary() {
        let sandbox = tempdir().unwrap();
        let root = sandbox.path().join("project");
        let parked = sandbox.path().join("parked");
        std::fs::create_dir_all(&root).unwrap();
        let expected = crate::commands::project_authority::capture_identity(&root)
            .await
            .unwrap();

        std::fs::rename(&root, &parked).unwrap();
        std::fs::create_dir_all(&root).unwrap();

        verify_spawn_cwd_identity(root.to_string_lossy().as_ref(), Some(&expected))
            .expect_err("replaced cwd must be rejected immediately before spawn");
    }
}

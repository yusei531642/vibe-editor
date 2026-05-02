// Codex plugin broker stale state cleanup.
//
// Issue #402:
// Codex plugin の broker state (`broker.json`) は正常な SessionEnd hook では消えるが、
// vibe-editor / worker の異常終了では stale な named pipe endpoint が残ることがある。
// 次回 Codex 起動時の handshake timeout を避けるため、Codex PTY の spawn 前と終了後に
// 「PID が死んでいる broker state だけ」を best-effort で掃除する。

use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::Command;

const PLUGIN_DATA_ENV: &str = "CLAUDE_PLUGIN_DATA";
const CODEX_PLUGIN_DATA_DIR: &str = "codex-openai-codex";
const BROKER_STATE_FILE: &str = "broker.json";
const FALLBACK_STATE_ROOT_DIR: &str = "codex-companion";
const BROKER_SESSION_PREFIX: &str = "cxc-";

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct CleanupSummary {
    pub checked: usize,
    pub removed_files: usize,
    pub removed_dirs: usize,
    pub skipped_live: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrokerSession {
    endpoint: Option<String>,
    pid_file: Option<String>,
    log_file: Option<String>,
    session_dir: Option<String>,
    pid: Option<u32>,
}

pub fn cleanup_stale_for_cwd(cwd: &str) -> CleanupSummary {
    let mut summary = CleanupSummary::default();
    for state_dir in resolve_state_dirs(cwd) {
        let part = cleanup_stale_in_state_dir(&state_dir, is_process_alive);
        summary.checked += part.checked;
        summary.removed_files += part.removed_files;
        summary.removed_dirs += part.removed_dirs;
        summary.skipped_live += part.skipped_live;
    }
    if summary.removed_files > 0 || summary.removed_dirs > 0 || summary.skipped_live > 0 {
        tracing::info!(
            "[codex_broker] cleanup cwd={} checked={} removed_files={} removed_dirs={} skipped_live={}",
            cwd,
            summary.checked,
            summary.removed_files,
            summary.removed_dirs,
            summary.skipped_live
        );
    }
    summary
}

fn cleanup_stale_in_state_dir(state_dir: &Path, is_alive: impl Fn(u32) -> bool) -> CleanupSummary {
    let mut summary = CleanupSummary::default();
    let broker_file = state_dir.join(BROKER_STATE_FILE);
    if !broker_file.is_file() {
        return summary;
    }
    summary.checked = 1;

    let session = match std::fs::read_to_string(&broker_file)
        .ok()
        .and_then(|s| serde_json::from_str::<BrokerSession>(&s).ok())
    {
        Some(session) => session,
        None => {
            tracing::warn!(
                "[codex_broker] malformed broker state skipped: {}",
                broker_file.display()
            );
            return summary;
        }
    };

    let Some(pid) = session.pid else {
        tracing::warn!(
            "[codex_broker] broker state without pid skipped: {}",
            broker_file.display()
        );
        return summary;
    };
    if is_alive(pid) {
        summary.skipped_live = 1;
        return summary;
    }

    let safe_session_dir = session
        .session_dir
        .as_deref()
        .map(PathBuf::from)
        .filter(|p| is_safe_broker_session_dir(p));

    summary.removed_files += remove_file_if_exists(&broker_file);

    if let Some(session_dir) = safe_session_dir.as_deref() {
        summary.removed_files += remove_file_inside_dir(session.pid_file.as_deref(), session_dir);
        summary.removed_files += remove_file_inside_dir(session.log_file.as_deref(), session_dir);
        summary.removed_files +=
            remove_unix_socket_inside_dir(session.endpoint.as_deref(), session_dir);
        summary.removed_dirs += remove_empty_dir_if_exists(session_dir);
    } else if session.session_dir.is_some() {
        tracing::warn!(
            "[codex_broker] unsafe broker sessionDir skipped: {:?}",
            session.session_dir
        );
    }

    summary
}

fn resolve_state_dirs(cwd: &str) -> Vec<PathBuf> {
    let workspace_root = resolve_workspace_root(cwd);
    let canonical = canonical_workspace_string(&workspace_root);
    let dir_name = state_dir_name_for_workspace(&workspace_root, &canonical);
    state_roots()
        .into_iter()
        .map(|root| root.join(&dir_name))
        .collect()
}

fn state_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(plugin_data) = std::env::var(PLUGIN_DATA_ENV) {
        if !plugin_data.trim().is_empty() {
            roots.push(PathBuf::from(plugin_data).join("state"));
        }
    }
    if let Some(home) = dirs::home_dir() {
        roots.push(
            home.join(".claude")
                .join("plugins")
                .join("data")
                .join(CODEX_PLUGIN_DATA_DIR)
                .join("state"),
        );
    }
    roots.push(std::env::temp_dir().join(FALLBACK_STATE_ROOT_DIR));
    roots.sort();
    roots.dedup();
    roots
}

fn resolve_workspace_root(cwd: &str) -> PathBuf {
    let cwd_path = PathBuf::from(cwd);
    let output = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(&cwd_path)
        .output();
    if let Ok(output) = output {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !text.is_empty() {
                return PathBuf::from(text);
            }
        }
    }
    cwd_path
}

fn canonical_workspace_string(path: &Path) -> String {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    strip_windows_verbatim_prefix(&canonical.to_string_lossy())
}

fn strip_windows_verbatim_prefix(raw: &str) -> String {
    if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    raw.strip_prefix(r"\\?\").unwrap_or(raw).to_string()
}

fn state_dir_name_for_workspace(workspace_root: &Path, canonical_workspace_root: &str) -> String {
    let slug_source = workspace_root
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("workspace");
    let slug = sanitize_slug(slug_source);
    let mut hasher = Sha256::new();
    hasher.update(canonical_workspace_root.as_bytes());
    let hash = hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    format!("{}-{}", slug, &hash[..16])
}

fn sanitize_slug(value: &str) -> String {
    let mapped: String = value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = mapped.trim_matches('-');
    if trimmed.is_empty() {
        "workspace".to_string()
    } else {
        trimmed.to_string()
    }
}

fn is_safe_broker_session_dir(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
        return false;
    };
    if !name.starts_with(BROKER_SESSION_PREFIX) {
        return false;
    }
    path_starts_with(path, &std::env::temp_dir())
}

fn path_starts_with(path: &Path, root: &Path) -> bool {
    let normalize = |p: &Path| {
        p.canonicalize()
            .unwrap_or_else(|_| p.to_path_buf())
            .to_string_lossy()
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_ascii_lowercase()
    };
    let path_s = normalize(path);
    let root_s = normalize(root);
    path_s == root_s || path_s.starts_with(&(root_s + "/"))
}

fn remove_file_if_exists(path: &Path) -> usize {
    if path.is_file() {
        match std::fs::remove_file(path) {
            Ok(()) => return 1,
            Err(e) => tracing::warn!("[codex_broker] remove file failed {}: {e}", path.display()),
        }
    }
    0
}

fn remove_file_inside_dir(raw: Option<&str>, dir: &Path) -> usize {
    let Some(raw) = raw else {
        return 0;
    };
    let path = PathBuf::from(raw);
    if path.is_file() && path_starts_with(&path, dir) {
        remove_file_if_exists(&path)
    } else {
        0
    }
}

fn remove_unix_socket_inside_dir(endpoint: Option<&str>, dir: &Path) -> usize {
    let Some(endpoint) = endpoint.and_then(|e| e.strip_prefix("unix:")) else {
        return 0;
    };
    let path = PathBuf::from(endpoint);
    if path.exists() && path_starts_with(&path, dir) {
        remove_file_if_exists(&path)
    } else {
        0
    }
}

fn remove_empty_dir_if_exists(path: &Path) -> usize {
    if path.is_dir() {
        match std::fs::remove_dir(path) {
            Ok(()) => return 1,
            Err(e) => tracing::debug!(
                "[codex_broker] broker session dir kept {}: {e}",
                path.display()
            ),
        }
    }
    0
}

fn is_process_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    is_process_alive_platform(pid).unwrap_or(true)
}

#[cfg(windows)]
fn is_process_alive_platform(pid: u32) -> Option<bool> {
    let filter = format!("PID eq {pid}");
    let output = Command::new("tasklist")
        .args(["/FI", &filter, "/FO", "CSV", "/NH"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let needle = format!("\"{pid}\"");
    Some(stdout.lines().any(|line| line.contains(&needle)))
}

#[cfg(not(windows))]
fn is_process_alive_platform(pid: u32) -> Option<bool> {
    let status = Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .ok()?;
    Some(status.success())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_case(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "vibe-codex-broker-test-{name}-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_broker(state_dir: &Path, session_dir: &Path, pid: u32) {
        fs::create_dir_all(state_dir).unwrap();
        fs::create_dir_all(session_dir).unwrap();
        fs::write(session_dir.join("broker.pid"), pid.to_string()).unwrap();
        fs::write(session_dir.join("broker.log"), "log").unwrap();
        let json = format!(
            r#"{{
  "endpoint": "pipe:\\\\.\\pipe\\cxc-test-codex-app-server",
  "pidFile": "{}",
  "logFile": "{}",
  "sessionDir": "{}",
  "pid": {}
}}
"#,
            session_dir
                .join("broker.pid")
                .to_string_lossy()
                .replace('\\', "\\\\"),
            session_dir
                .join("broker.log")
                .to_string_lossy()
                .replace('\\', "\\\\"),
            session_dir.to_string_lossy().replace('\\', "\\\\"),
            pid
        );
        fs::write(state_dir.join(BROKER_STATE_FILE), json).unwrap();
    }

    #[test]
    fn state_dir_name_matches_codex_plugin_format() {
        let name = state_dir_name_for_workspace(Path::new("vive-editor"), r"F:\vive-editor");
        assert_eq!(name, "vive-editor-0878b76ff54a1305");
    }

    #[test]
    fn dead_pid_removes_broker_files_and_safe_session_dir() {
        let state_dir = temp_case("dead-state");
        let session_dir =
            std::env::temp_dir().join(format!("cxc-vibe-test-{}", uuid::Uuid::new_v4()));
        write_broker(&state_dir, &session_dir, 999_999);

        let summary = cleanup_stale_in_state_dir(&state_dir, |_| false);

        assert_eq!(summary.checked, 1);
        assert_eq!(summary.removed_files, 3);
        assert_eq!(summary.removed_dirs, 1);
        assert!(!state_dir.join(BROKER_STATE_FILE).exists());
        assert!(!session_dir.exists());
        let _ = fs::remove_dir_all(state_dir);
    }

    #[test]
    fn live_pid_keeps_broker_state_intact() {
        let state_dir = temp_case("live-state");
        let session_dir =
            std::env::temp_dir().join(format!("cxc-vibe-test-{}", uuid::Uuid::new_v4()));
        write_broker(&state_dir, &session_dir, std::process::id());

        let summary = cleanup_stale_in_state_dir(&state_dir, |_| true);

        assert_eq!(summary.checked, 1);
        assert_eq!(summary.skipped_live, 1);
        assert!(state_dir.join(BROKER_STATE_FILE).exists());
        assert!(session_dir.join("broker.pid").exists());
        let _ = fs::remove_dir_all(state_dir);
        let _ = fs::remove_dir_all(session_dir);
    }

    #[test]
    fn malformed_broker_state_is_noop() {
        let state_dir = temp_case("malformed");
        fs::write(state_dir.join(BROKER_STATE_FILE), "{not-json").unwrap();

        let summary = cleanup_stale_in_state_dir(&state_dir, |_| false);

        assert_eq!(summary.checked, 1);
        assert_eq!(summary.removed_files, 0);
        assert!(state_dir.join(BROKER_STATE_FILE).exists());
        let _ = fs::remove_dir_all(state_dir);
    }

    #[test]
    fn unsafe_session_dir_does_not_remove_external_files() {
        let state_dir = temp_case("unsafe-state");
        let unsafe_dir = state_dir.join("not-temp-cxc");
        write_broker(&state_dir, &unsafe_dir, 999_999);

        let summary = cleanup_stale_in_state_dir(&state_dir, |_| false);

        assert_eq!(summary.checked, 1);
        assert_eq!(summary.removed_files, 1);
        assert_eq!(summary.removed_dirs, 0);
        assert!(!state_dir.join(BROKER_STATE_FILE).exists());
        assert!(unsafe_dir.join("broker.pid").exists());
        let _ = fs::remove_dir_all(state_dir);
    }
}

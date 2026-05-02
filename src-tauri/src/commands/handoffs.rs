// handoffs.* command — Canvas agent/session handoff persistence.
//
// Handoff bodies can become large, so Canvas localStorage and team-history only
// store references. The canonical content lives under ~/.vibe-editor/handoffs/.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tokio::fs;
use uuid::Uuid;

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct HandoffContent {
    pub summary: String,
    #[serde(default)]
    pub decisions: Vec<String>,
    #[serde(default)]
    pub files_touched: Vec<String>,
    #[serde(default)]
    pub open_tasks: Vec<String>,
    #[serde(default)]
    pub risks: Vec<String>,
    #[serde(default)]
    pub next_actions: Vec<String>,
    #[serde(default)]
    pub verification: Vec<String>,
    #[serde(default)]
    pub notes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_snapshot: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffCreateRequest {
    pub project_root: String,
    #[serde(default)]
    pub team_id: Option<String>,
    pub kind: String,
    #[serde(default)]
    pub from_agent_id: Option<String>,
    #[serde(default)]
    pub from_role: Option<String>,
    #[serde(default)]
    pub from_agent: Option<String>,
    #[serde(default)]
    pub from_title: Option<String>,
    #[serde(default)]
    pub source_session_id: Option<String>,
    #[serde(default)]
    pub replacement_for_agent_id: Option<String>,
    #[serde(default)]
    pub retire_after_ack: bool,
    pub trigger: String,
    pub content: HandoffContent,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HandoffCheckpoint {
    pub schema_version: u32,
    pub id: String,
    pub project_root: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replacement_for_agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_agent_id: Option<String>,
    pub retire_after_ack: bool,
    pub trigger: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub json_path: String,
    pub markdown_path: String,
    pub content: HandoffContent,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HandoffCreateResult {
    pub ok: bool,
    pub handoff: Option<HandoffCheckpoint>,
    pub error: Option<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HandoffMutationResult {
    pub ok: bool,
    pub handoff: Option<HandoffCheckpoint>,
    pub error: Option<String>,
}

fn handoff_root() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".vibe-editor")
        .join("handoffs")
}

fn project_key(project_root: &str) -> String {
    let normalized = crate::pty::path_norm::normalize_project_root(project_root);
    URL_SAFE_NO_PAD.encode(normalized.as_bytes())
}

fn safe_segment(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        "standalone".to_string()
    } else {
        out.chars().take(96).collect()
    }
}

fn handoff_dir(project_root: &str, team_id: Option<&str>) -> PathBuf {
    let team = safe_segment(team_id.unwrap_or("standalone"));
    handoff_root().join(project_key(project_root)).join(team)
}

async fn ensure_private_handoff_dir(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).await.map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let root = handoff_root();
        let mut dirs = vec![root.as_path()];
        if let Some(project_dir) = dir.parent() {
            dirs.push(project_dir);
        }
        dirs.push(dir);

        for path in dirs {
            fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

async fn restrict_private_file(_path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(_path, std::fs::Permissions::from_mode(0o600))
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn normalize_status(status: &str) -> Option<&'static str> {
    match status {
        "created" => Some("created"),
        "started" => Some("started"),
        "acknowledged" => Some("acknowledged"),
        "retired" => Some("retired"),
        "failed" => Some("failed"),
        _ => None,
    }
}

fn markdown_list(items: &[String]) -> String {
    if items.is_empty() {
        "- 未記録\n".to_string()
    } else {
        items
            .iter()
            .map(|item| format!("- {}\n", item.trim()))
            .collect::<String>()
    }
}

fn render_markdown(h: &HandoffCheckpoint) -> String {
    let mut out = String::new();
    out.push_str(&format!("# Handoff {}\n\n", h.id));
    out.push_str(&format!("- Kind: {}\n", h.kind));
    out.push_str(&format!("- Status: {}\n", h.status));
    out.push_str(&format!("- Created: {}\n", h.created_at));
    if let Some(team_id) = &h.team_id {
        out.push_str(&format!("- Team: {}\n", team_id));
    }
    if let Some(agent_id) = &h.from_agent_id {
        out.push_str(&format!("- From agent: {}\n", agent_id));
    }
    if let Some(role) = &h.from_role {
        out.push_str(&format!("- From role: {}\n", role));
    }
    if let Some(session_id) = &h.source_session_id {
        out.push_str(&format!("- Source session: {}\n", session_id));
    }
    if let Some(replacement) = &h.replacement_for_agent_id {
        out.push_str(&format!("- Replacement for: {}\n", replacement));
    }
    out.push_str("\n## Summary\n\n");
    out.push_str(h.content.summary.trim());
    out.push_str("\n\n## Decisions\n\n");
    out.push_str(&markdown_list(&h.content.decisions));
    out.push_str("\n## Files Touched\n\n");
    out.push_str(&markdown_list(&h.content.files_touched));
    out.push_str("\n## Open Tasks\n\n");
    out.push_str(&markdown_list(&h.content.open_tasks));
    out.push_str("\n## Risks\n\n");
    out.push_str(&markdown_list(&h.content.risks));
    out.push_str("\n## Next Actions\n\n");
    out.push_str(&markdown_list(&h.content.next_actions));
    out.push_str("\n## Verification\n\n");
    out.push_str(&markdown_list(&h.content.verification));
    out.push_str("\n## Notes\n\n");
    out.push_str(&markdown_list(&h.content.notes));
    if let Some(snapshot) = h
        .content
        .terminal_snapshot
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        out.push_str("\n## Terminal Snapshot\n\n```text\n");
        out.push_str(snapshot);
        out.push_str("\n```\n");
    }
    out
}

async fn write_handoff(
    handoff: &HandoffCheckpoint,
    json_path: &Path,
    md_path: &Path,
) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(handoff).map_err(|e| e.to_string())?;
    crate::commands::atomic_write::atomic_write(json_path, &json)
        .await
        .map_err(|e| e.to_string())?;
    restrict_private_file(json_path).await?;
    let markdown = render_markdown(handoff);
    crate::commands::atomic_write::atomic_write(md_path, markdown.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    restrict_private_file(md_path).await
}

#[tauri::command]
pub async fn handoffs_create(req: HandoffCreateRequest) -> HandoffCreateResult {
    if req.project_root.trim().is_empty() {
        return HandoffCreateResult {
            ok: false,
            error: Some("projectRoot is required".into()),
            handoff: None,
        };
    }
    let dir = handoff_dir(&req.project_root, req.team_id.as_deref());
    if let Err(e) = ensure_private_handoff_dir(&dir).await {
        return HandoffCreateResult {
            ok: false,
            error: Some(e),
            handoff: None,
        };
    }
    let now = Utc::now().to_rfc3339();
    let short_uuid = Uuid::new_v4().to_string()[..8].to_string();
    let id = format!("handoff-{}-{short_uuid}", Utc::now().format("%Y%m%d%H%M%S"));
    let json_path = dir.join(format!("{id}.json"));
    let markdown_path = dir.join(format!("{id}.md"));
    let handoff = HandoffCheckpoint {
        schema_version: 1,
        id,
        project_root: req.project_root,
        team_id: req.team_id,
        kind: req.kind,
        from_agent_id: req.from_agent_id,
        from_role: req.from_role,
        from_agent: req.from_agent,
        from_title: req.from_title,
        source_session_id: req.source_session_id,
        replacement_for_agent_id: req.replacement_for_agent_id,
        to_agent_id: None,
        retire_after_ack: req.retire_after_ack,
        trigger: req.trigger,
        status: "created".into(),
        created_at: now.clone(),
        updated_at: now,
        json_path: json_path.to_string_lossy().into_owned(),
        markdown_path: markdown_path.to_string_lossy().into_owned(),
        content: req.content,
    };
    match write_handoff(&handoff, &json_path, &markdown_path).await {
        Ok(()) => HandoffCreateResult {
            ok: true,
            handoff: Some(handoff),
            error: None,
        },
        Err(e) => HandoffCreateResult {
            ok: false,
            error: Some(e),
            handoff: None,
        },
    }
}

#[tauri::command]
pub async fn handoffs_list(
    project_root: String,
    team_id: Option<String>,
) -> Vec<HandoffCheckpoint> {
    let dir = handoff_dir(&project_root, team_id.as_deref());
    let mut out = Vec::new();
    let mut rd = match fs::read_dir(&dir).await {
        Ok(r) => r,
        Err(_) => return out,
    };
    while let Ok(Some(entry)) = rd.next_entry().await {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Ok(bytes) = fs::read(&path).await else {
            continue;
        };
        let Ok(handoff) = serde_json::from_slice::<HandoffCheckpoint>(&bytes) else {
            continue;
        };
        out.push(handoff);
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    out
}

#[tauri::command]
pub async fn handoffs_read(
    project_root: String,
    team_id: Option<String>,
    handoff_id: String,
) -> Option<HandoffCheckpoint> {
    let id = safe_segment(&handoff_id);
    let path = handoff_dir(&project_root, team_id.as_deref()).join(format!("{id}.json"));
    let bytes = fs::read(&path).await.ok()?;
    serde_json::from_slice::<HandoffCheckpoint>(&bytes).ok()
}

#[tauri::command]
pub async fn handoffs_update_status(
    project_root: String,
    team_id: Option<String>,
    handoff_id: String,
    status: String,
    to_agent_id: Option<String>,
) -> HandoffMutationResult {
    let Some(next_status) = normalize_status(status.as_str()) else {
        return HandoffMutationResult {
            ok: false,
            error: Some("invalid handoff status".into()),
            handoff: None,
        };
    };
    let id = safe_segment(&handoff_id);
    let dir = handoff_dir(&project_root, team_id.as_deref());
    let json_path = dir.join(format!("{id}.json"));
    let md_path = dir.join(format!("{id}.md"));
    let bytes = match fs::read(&json_path).await {
        Ok(b) => b,
        Err(e) => {
            return HandoffMutationResult {
                ok: false,
                error: Some(e.to_string()),
                handoff: None,
            }
        }
    };
    let mut handoff = match serde_json::from_slice::<HandoffCheckpoint>(&bytes) {
        Ok(h) => h,
        Err(e) => {
            return HandoffMutationResult {
                ok: false,
                error: Some(e.to_string()),
                handoff: None,
            }
        }
    };
    handoff.status = next_status.to_string();
    if let Some(to_agent_id) = to_agent_id {
        handoff.to_agent_id = Some(to_agent_id);
    }
    handoff.updated_at = Utc::now().to_rfc3339();
    match write_handoff(&handoff, &json_path, &md_path).await {
        Ok(()) => HandoffMutationResult {
            ok: true,
            handoff: Some(handoff),
            error: None,
        },
        Err(e) => HandoffMutationResult {
            ok: false,
            error: Some(e),
            handoff: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{project_key, safe_segment};

    #[test]
    fn safe_segment_removes_path_separators() {
        assert_eq!(safe_segment("../team:id"), ".._team_id");
        assert_eq!(safe_segment(""), "standalone");
    }

    #[test]
    fn project_key_is_url_safe() {
        let key = project_key(r"C:\Users\me\repo");
        assert!(!key.contains('\\'));
        assert!(!key.contains('/'));
        assert!(!key.contains('='));
    }
}

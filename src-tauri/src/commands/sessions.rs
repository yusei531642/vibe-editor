// sessions.* command — 旧 src/main/ipc/sessions.ts に対応
//
// ~/.claude/projects/<encoded-projectRoot>/*.jsonl を列挙し、
// 各 jsonl から最初のユーザーメッセージ (=タイトル) と message count を抽出する。

use crate::pty::path_norm::{encode_project_path, normalize_project_root};
use serde::Serialize;
use std::path::PathBuf;
use tokio::io::AsyncBufReadExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub path: String,
    pub title: String,
    pub message_count: u32,
    pub last_modified_at: String,
}

fn projects_dir(root: &str) -> PathBuf {
    let home = dirs::home_dir().unwrap_or_default();
    home.join(".claude").join("projects").join(encode_project_path(root))
}

#[tauri::command]
pub async fn sessions_list(project_root: String) -> Vec<SessionInfo> {
    let dir = projects_dir(&project_root);
    let mut rd = match tokio::fs::read_dir(&dir).await {
        Ok(r) => r,
        Err(_) => return vec![],
    };
    // Issue #31: encode_project_path は非英数を '-' に潰すので、別 project が同じ
    // encoded directory に衝突し得る (例: `C:\repo-a` と `C:\repo\a`)。
    // jsonl 内に Claude Code が書き込む cwd を読んで、異なる project のものは除外する。
    let requested_norm = normalize_project_root(&project_root);
    let mut sessions = vec![];
    while let Ok(Some(entry)) = rd.next_entry().await {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let metadata = match tokio::fs::metadata(&path).await {
            Ok(m) => m,
            Err(_) => continue,
        };
        let last_modified_at = metadata
            .modified()
            .ok()
            .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339())
            .unwrap_or_default();

        let (title, count, cwd) = read_jsonl_summary(&path).await;
        // cwd が jsonl から取れたときだけ厳密チェック (取れないものは fail-open)
        if let Some(ref c) = cwd {
            if !c.trim().is_empty() && normalize_project_root(c) != requested_norm {
                tracing::debug!(
                    "[sessions] skipping colliding session {id}: cwd={c} != requested={project_root}"
                );
                continue;
            }
        }
        sessions.push(SessionInfo {
            id,
            path: path.to_string_lossy().into_owned(),
            title,
            message_count: count,
            last_modified_at,
        });
    }
    // 新しい順
    sessions.sort_by(|a, b| b.last_modified_at.cmp(&a.last_modified_at));
    sessions
}

/// jsonl から (title, count, cwd) を抽出。cwd は最初に見つかった `cwd` フィールド。
async fn read_jsonl_summary(path: &std::path::Path) -> (String, u32, Option<String>) {
    let f = match tokio::fs::File::open(path).await {
        Ok(f) => f,
        Err(_) => return (String::new(), 0, None),
    };
    let reader = tokio::io::BufReader::new(f);
    let mut lines = reader.lines();
    let mut title = String::new();
    let mut count = 0u32;
    let mut cwd: Option<String> = None;
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        count += 1;
        if title.is_empty() || cwd.is_none() {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                if cwd.is_none() {
                    // Claude Code は meta entry や user entry に "cwd" を載せる
                    if let Some(c) = v.get("cwd").and_then(|c| c.as_str()) {
                        cwd = Some(c.to_string());
                    }
                }
                if title.is_empty()
                    && v.get("type").and_then(|t| t.as_str()) == Some("user")
                {
                    if let Some(text) = v
                        .pointer("/message/content")
                        .and_then(|c| c.as_str())
                        .or_else(|| {
                            v.pointer("/message/content/0/text")
                                .and_then(|t| t.as_str())
                        })
                    {
                        title = text.lines().next().unwrap_or("").chars().take(80).collect();
                    }
                }
            }
        }
    }
    (title, count, cwd)
}

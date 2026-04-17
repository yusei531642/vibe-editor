// sessions.* command — 旧 src/main/ipc/sessions.ts に対応
//
// ~/.claude/projects/<encoded-projectRoot>/*.jsonl を列挙し、
// 各 jsonl から最初のユーザーメッセージ (=タイトル) と message count を抽出する。

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

fn encode_project_path(root: &str) -> String {
    // 旧 encodeProjectPath: 非英数を `-` に置換
    root.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
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

        let (title, count) = read_jsonl_summary(&path).await;
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

async fn read_jsonl_summary(path: &std::path::Path) -> (String, u32) {
    let f = match tokio::fs::File::open(path).await {
        Ok(f) => f,
        Err(_) => return (String::new(), 0),
    };
    let reader = tokio::io::BufReader::new(f);
    let mut lines = reader.lines();
    let mut title = String::new();
    let mut count = 0u32;
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        count += 1;
        if title.is_empty() {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                if v.get("type").and_then(|t| t.as_str()) == Some("user") {
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
    (title, count)
}

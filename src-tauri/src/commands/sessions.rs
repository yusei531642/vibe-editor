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
    pub last_modified_ms: i64,
}

fn projects_dir(root: &str) -> PathBuf {
    let home = dirs::home_dir().unwrap_or_default();
    home.join(".claude")
        .join("projects")
        .join(encode_project_path(root))
}

#[tauri::command]
pub async fn sessions_list(project_root: String) -> Vec<SessionInfo> {
    let dir = projects_dir(&project_root);
    let Ok(mut rd) = tokio::fs::read_dir(&dir).await else {
        return vec![];
    };
    // Issue #31: encode_project_path は非英数を '-' に潰すので、別 project が同じ
    // encoded directory に衝突し得る (例: `C:\repo-a` と `C:\repo\a`)。
    // jsonl 内に Claude Code が書き込む cwd を読んで、異なる project のものは除外する。
    let requested_norm = normalize_project_root(&project_root);

    // Issue #127: 旧実装は metadata + read_jsonl_summary を 1 ファイルずつ直列に await
    // しており、100+ セッションあるプロジェクトで I/O 直列化により 1〜3 秒かかっていた。
    //
    // 1-pass: read_dir で jsonl 候補と metadata を集める (read_dir 自体は順次)。
    // 2-pass: read_jsonl_summary を tokio::task::JoinSet で並列化 (CONCURRENCY=8)。
    //         並列度を絞ってファイルディスクリプタ枯渇を防ぐ。
    struct Candidate {
        id: String,
        path: PathBuf,
        last_modified_at: String,
        last_modified_ms: i64,
    }
    let mut candidates: Vec<Candidate> = Vec::new();
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
        let Ok(metadata) = tokio::fs::metadata(&path).await else {
            continue;
        };
        let last_modified_at = metadata
            .modified()
            .ok()
            .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339())
            .unwrap_or_default();
        let last_modified_ms = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
            .unwrap_or(0);
        candidates.push(Candidate {
            id,
            path,
            last_modified_at,
            last_modified_ms,
        });
    }

    // 並列に summary を抽出。CONCURRENCY=8 で fd 枯渇を回避しつつ十分な高速化を得る。
    const CONCURRENCY: usize = 8;
    let mut sessions: Vec<SessionInfo> = Vec::with_capacity(candidates.len());
    let mut iter = candidates.into_iter();
    let mut in_flight: tokio::task::JoinSet<(Candidate, String, u32, Option<String>)> =
        tokio::task::JoinSet::new();

    let spawn_one = |set: &mut tokio::task::JoinSet<(Candidate, String, u32, Option<String>)>,
                     cand: Candidate| {
        set.spawn(async move {
            let (title, count, cwd) = read_jsonl_summary(&cand.path).await;
            (cand, title, count, cwd)
        });
    };

    for _ in 0..CONCURRENCY {
        if let Some(cand) = iter.next() {
            spawn_one(&mut in_flight, cand);
        }
    }
    while let Some(joined) = in_flight.join_next().await {
        if let Ok((cand, title, count, cwd)) = joined {
            // 後続を 1 件 spawn して並列度を維持
            if let Some(next) = iter.next() {
                spawn_one(&mut in_flight, next);
            }
            // cwd が jsonl から取れたときだけ厳密チェック (取れないものは fail-open)
            if let Some(ref c) = cwd {
                if !c.trim().is_empty() && normalize_project_root(c) != requested_norm {
                    tracing::debug!(
                        "[sessions] skipping colliding session {}: cwd={} != requested={}",
                        cand.id,
                        c,
                        project_root
                    );
                    continue;
                }
            }
            sessions.push(SessionInfo {
                id: cand.id,
                path: cand.path.to_string_lossy().into_owned(),
                title,
                message_count: count,
                last_modified_at: cand.last_modified_at,
                last_modified_ms: cand.last_modified_ms,
            });
        }
    }
    // 新しい順
    sessions.sort_by(|a, b| b.last_modified_at.cmp(&a.last_modified_at));
    sessions
}

/// jsonl から (title, count, cwd) を抽出。cwd は最初に見つかった `cwd` フィールド。
///
/// Issue #43: 大きなセッション (数百 MB) の jsonl を毎回全行読みすると list API が
/// 数秒〜十数秒ブロックする。
///   - title / cwd は先頭付近 (1〜8 行目) にしか出ないので早期 break する
///   - message_count の「正確な数」は UI で "500+" 等と見せれば十分なので、
///     先頭 HEAD_LIMIT_LINES = 2000 行まで数え、超えたら上限値を返す
///     (正確な行数は fs::metadata の行数相当だと OS 依存で取れないので割り切る)
async fn read_jsonl_summary(path: &std::path::Path) -> (String, u32, Option<String>) {
    const HEAD_LIMIT_LINES: u32 = 2000;
    let Ok(f) = tokio::fs::File::open(path).await else {
        return (String::new(), 0, None);
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
        // 先頭 8 行だけ serde_json で parse (title / cwd 抽出用)
        if count <= 8 && (title.is_empty() || cwd.is_none()) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                if cwd.is_none() {
                    if let Some(c) = v.get("cwd").and_then(|c| c.as_str()) {
                        cwd = Some(c.to_string());
                    }
                }
                if title.is_empty() && v.get("type").and_then(|t| t.as_str()) == Some("user") {
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
        // Issue #106: title/cwd が取れなくても上限行数で必ず break する。
        // 旧実装は break 条件に `!title.is_empty() && cwd.is_some()` を含めていたため、
        // それらが欠けた jsonl (壊れている / 古い形式) では数百 MB を最後まで読み続け、
        // セッション履歴表示が数秒〜十数秒ブロックしていた。
        if count >= HEAD_LIMIT_LINES {
            break;
        }
    }
    (title, count, cwd)
}

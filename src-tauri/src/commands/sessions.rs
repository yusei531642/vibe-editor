// sessions.* command — 旧 src/main/ipc/sessions.ts に対応
//
// ~/.claude/projects/<encoded-projectRoot>/*.jsonl を列挙し、
// 各 jsonl から最初のユーザーメッセージ (=タイトル) と message count を抽出する。

use crate::commands::authz::AuthorizedActiveProjectRoot;
use crate::commands::error::CommandResult;
use crate::pty::path_norm::encode_project_path;
use crate::state::AppState;
use arc_swap::ArcSwapOption;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::State;
use tokio::io::AsyncBufReadExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub path: String,
    pub title: String,
    /// Issue #837: 会話メッセージ (type == "user" | "assistant") の件数。
    /// `message_count_capped == true` のとき、先頭 HEAD_LIMIT_LINES 行で打ち切った
    /// 下限値 (= "N+" 表示用) であり、正確な総数ではない。
    pub message_count: u32,
    /// Issue #837: `message_count` が先頭 HEAD_LIMIT_LINES (2000) 行の走査上限に達して
    /// 打ち切られたかどうか。true のとき UI は "N+" を描画する。
    pub message_count_capped: bool,
    pub last_modified_at: String,
    pub last_modified_ms: i64,
}

fn projects_dir(home: &Path, root: &str) -> PathBuf {
    home.join(".claude")
        .join("projects")
        .join(encode_project_path(root))
}

/// JSONLに保存されたcwdを、gate後のI/Oなしで比較するためのkeyにする。
///
/// `normalize_project_root` はcanonicalizeを含むため、保存後にsymlinkがretargetされると
/// foreign cwdをactive identityとして再解決してしまう。storage互換のためraw表記を保った
/// まま、区切り・末尾slash・Windows caseだけを純粋に正規化する。
fn lexical_project_root_key(raw: &str) -> String {
    let normalized = raw.replace('\\', "/");
    let stripped = normalized.trim_end_matches('/');
    if cfg!(windows) {
        stripped.to_lowercase()
    } else {
        stripped.to_string()
    }
}

#[tauri::command]
pub async fn sessions_list(
    state: State<'_, AppState>,
    project_root: String,
) -> CommandResult<Vec<SessionInfo>> {
    let home = dirs::home_dir().unwrap_or_default();
    sessions_list_via(&state.project_root, project_root, move |authorized| {
        sessions_list_from_home(authorized, home)
    })
    .await
}

/// command入口のstrict gateと後続readerの順序を1か所に固定する。readerは
/// `AuthorizedActiveProjectRoot` なしでは呼べないため、拒否requestはdirectory I/Oへ進まない。
pub(crate) async fn sessions_list_via<R, Reader, Fut>(
    project_root_slot: &ArcSwapOption<String>,
    project_root: String,
    reader: Reader,
) -> CommandResult<R>
where
    Reader: FnOnce(AuthorizedActiveProjectRoot) -> Fut,
    Fut: std::future::Future<Output = R>,
{
    let authorized = crate::commands::authz::assert_active_project_root_with_raw(
        project_root_slot,
        &project_root,
    )
    .await?;
    Ok(reader(authorized).await)
}

/// 認可済みactive rawをClaude CLI互換でencodeし、session metadataを列挙する。
/// `home`を引数化して、実HOMEを変更せずdirectory selectionを統合テストできるようにする。
pub(crate) async fn sessions_list_from_home(
    authorized: AuthorizedActiveProjectRoot,
    home: PathBuf,
) -> Vec<SessionInfo> {
    // directoryは既存Claude互換のactive raw、cwd selectorはgate時canonical identityと
    // 同じsnapshotのactive raw identityのいずれかだけを許可する。どちらも後続I/Oなし。
    let active_raw_key = authorized.active_raw_key();
    let (canonical, project_root) = authorized.into_parts();
    let dir = projects_dir(&home, &project_root);
    let Ok(mut rd) = tokio::fs::read_dir(&dir).await else {
        return vec![];
    };
    // Issue #31: encode_project_path は非英数を '-' に潰すので、別 project が同じ
    // encoded directory に衝突し得る (例: `C:\repo-a` と `C:\repo\a`)。
    // jsonl 内に Claude Code が書き込む cwd を読んで、異なる project のものは除外する。
    let canonical_key = canonical.comparison_key();

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
    let mut in_flight: tokio::task::JoinSet<(Candidate, JsonlSummary)> =
        tokio::task::JoinSet::new();

    let spawn_one = |set: &mut tokio::task::JoinSet<(Candidate, JsonlSummary)>, cand: Candidate| {
        set.spawn(async move {
            let summary = read_jsonl_summary(&cand.path).await;
            (cand, summary)
        });
    };

    for _ in 0..CONCURRENCY {
        if let Some(cand) = iter.next() {
            spawn_one(&mut in_flight, cand);
        }
    }
    while let Some(joined) = in_flight.join_next().await {
        if let Ok((cand, summary)) = joined {
            // 後続を 1 件 spawn して並列度を維持
            if let Some(next) = iter.next() {
                spawn_one(&mut in_flight, next);
            }
            // cwd が jsonl から取れたときだけ厳密チェック (取れないものは fail-open)
            if let Some(ref c) = summary.cwd {
                let cwd_key = lexical_project_root_key(c);
                if !c.trim().is_empty() && cwd_key != canonical_key && cwd_key != active_raw_key {
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
                title: summary.title,
                message_count: summary.message_count,
                message_count_capped: summary.capped,
                last_modified_at: cand.last_modified_at,
                last_modified_ms: cand.last_modified_ms,
            });
        }
    }
    // 新しい順
    sessions.sort_by(|a, b| b.last_modified_at.cmp(&a.last_modified_at));
    sessions
}

/// `read_jsonl_summary` の戻り値。
///
/// Issue #837: 旧実装は `(title, count, cwd)` の tuple を返し、`count` は **行種別を問わない
/// 非空行数 (上限付き)** だった。これを (1) 会話メッセージ件数に限定し、(2) 走査上限に達したかを
/// 表す `capped` を加えた struct に置き換える。フィールド名で意味が自明になり、UI 側が "N+" を
/// 描画できるようになる。
pub(crate) struct JsonlSummary {
    /// 最初のユーザーメッセージ先頭行 (最大 80 文字)。
    pub title: String,
    /// 会話メッセージ (type == "user" | "assistant") の件数。
    /// `capped == true` のときは走査上限内で数えた下限値。
    pub message_count: u32,
    /// jsonl 内で最初に見つかった `cwd` フィールド。
    pub cwd: Option<String>,
    /// `message_count` が先頭 HEAD_LIMIT_LINES 行で打ち切られたか。
    pub capped: bool,
}

/// 行が会話メッセージ (`type == "user" | "assistant"`) かを、全文 JSON パースを避けて
/// 安価に判定する (Issue #837 / PR #851 review)。
///
/// Claude Code の JSONL は compact JSON (`serde_json::to_string` 相当) で 1 行 1 オブジェクトを
/// 書き、JSON 文字列値の中の `"` は必ず `\"` にエスケープされる。したがって **未エスケープの
/// `"type":"user"` / `"type":"assistant"` という並びは実際のキー:値ペアにしか出現しない**
/// (content 文字列の中身には現れない)。これにより、大きな content を含む行でも全文を
/// `serde_json` でトークナイズ/アロケートせず、SIMD 化された substring 検索だけで判定できる
/// (旧実装は最大 2000 行に対し毎行 `from_str` していて large-content セッションで CPU を浪費していた)。
///
/// 末尾の閉じ `"` まで含めて照合するので `"type":"user_cancelled"` のような前方一致型では
/// 誤検出しない。compact 形と「コロン後 1 スペース」形の両方を許容する。
fn line_is_conversation_message(line: &str) -> bool {
    const PATTERNS: [&str; 4] = [
        r#""type":"user""#,
        r#""type":"assistant""#,
        r#""type": "user""#,
        r#""type": "assistant""#,
    ];
    PATTERNS.iter().any(|p| line.contains(p))
}

/// jsonl から title / message_count / cwd / capped を抽出する。
///
/// Issue #43 / #106: 大きなセッション (数百 MB) の jsonl を毎回全行読みすると list API が
/// 数秒〜十数秒ブロックする。
///   - title / cwd は先頭付近 (1〜8 行目) にしか出ないので先頭 8 行だけ full parse する
///   - I/O 量は「走査した非空行数」を先頭 HEAD_LIMIT_LINES = 2000 行で打ち切って bound する
///
/// Issue #837: 旧実装は行種別を問わず数え、2000 行で無告知に頭打ちしていた。本実装では
///   - 会話メッセージ (type == "user" | "assistant") のみを `message_count` に数える
///     (summary / system / tool_result / file-history-snapshot 等は除外)
///   - 走査上限に達し、かつさらに行が残っていれば `capped = true` を立てて UI が "N+" を
///     描画できるようにする
///
/// Issue #494: integration test (`commands/tests/sessions.rs`) から fixture jsonl に対して
/// 直接呼べるよう `pub(crate)` で expose。Tauri command 経由ではないので AppHandle / State 不要。
pub(crate) async fn read_jsonl_summary(path: &std::path::Path) -> JsonlSummary {
    const HEAD_LIMIT_LINES: u32 = 2000;
    let Ok(f) = tokio::fs::File::open(path).await else {
        return JsonlSummary {
            title: String::new(),
            message_count: 0,
            cwd: None,
            capped: false,
        };
    };
    let reader = tokio::io::BufReader::new(f);
    let mut lines = reader.lines();
    let mut title = String::new();
    let mut message_count = 0u32;
    let mut cwd: Option<String> = None;
    // I/O 量は「走査した非空行数」で bound する (message_count ではなく行数で打ち切る)。
    let mut lines_scanned = 0u32;
    let mut capped = false;
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        lines_scanned += 1;

        // Issue #837: 会話メッセージ (type == user|assistant) だけを数える。
        // 全文 JSON パースを避けるため substring 検索で判定する (PR #851 review / perf)。
        if line_is_conversation_message(&line) {
            message_count += 1;
        }

        // 先頭 8 行だけ serde_json で full parse (title / cwd 抽出用)
        if lines_scanned <= 8 && (title.is_empty() || cwd.is_none()) {
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
        if lines_scanned >= HEAD_LIMIT_LINES {
            // Issue #837: 上限到達。さらに非空行が残っているかを 1 行だけ覗いて capped を確定する
            // (ちょうど HEAD_LIMIT_LINES 行のセッションを誤って "N+" と表示しないため。
            //  追加読込は 1 行のみなので I/O bound は維持される)。
            capped = matches!(lines.next_line().await, Ok(Some(_)));
            break;
        }
    }
    JsonlSummary {
        title,
        message_count,
        cwd,
        capped,
    }
}

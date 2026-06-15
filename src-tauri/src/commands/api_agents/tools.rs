// api_agents/tools — API エージェントがモデルに公開する読み取り専用ツール (Issue #1002)。
//
// v1 スコープ: read_file / list_dir のみ。書込・シェル実行は対象外。
//
// セキュリティ方針:
//   - 参照は active project root (caller が state から取得した信頼値) 配下のみ。
//   - canonicalize して root 配下に収まることを検証し、`..` traversal / symlink escape を拒否。
//   - read_file はサイズ上限、list_dir は件数上限でキャップする。
//
// ツール実行は同期 fs (小さなローカル読み取りのみ) で行い、provider アダプタの非ストリーミング
// tool-loop から `FnMut(&str, &Value) -> ToolOutcome` クロージャ経由で呼ばれる。

use serde_json::{json, Value};
use std::path::PathBuf;

/// read_file が一度に返す最大バイト数。
const MAX_READ_BYTES: u64 = 64 * 1024;
/// list_dir が返す最大エントリ数。
const MAX_LIST_ENTRIES: usize = 200;

/// モデルへ渡すツール定義 (provider 非依存)。各アダプタが自身の関数呼び出し形式へ変換する。
pub(super) struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    /// JSON Schema (OpenAI function parameters 互換)。
    pub parameters: Value,
}

/// ツール 1 回の実行結果。`is_error` のときはモデルにエラーであることを伝える。
pub(super) struct ToolOutcome {
    pub content: String,
    pub is_error: bool,
}

impl ToolOutcome {
    fn ok(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            is_error: false,
        }
    }
    fn err(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            is_error: true,
        }
    }
}

/// v1 の読み取り専用ツール定義。
pub(super) fn builtin_read_tools() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "read_file",
            description: "Read a UTF-8 text file from the current project. \
                Path is relative to the project root. Read-only. \
                Optionally pass 'offset' (1-based start line) and 'limit' (line count) \
                to read a slice of a large file.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "File path relative to the project root."
                    },
                    "offset": {
                        "type": "integer",
                        "minimum": 1,
                        "description": "1-based line number to start reading from (optional, >= 1)."
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "description": "Maximum number of lines to read from 'offset' (optional, >= 1)."
                    }
                },
                "required": ["path"]
            }),
        },
        ToolSpec {
            name: "list_dir",
            description: "List entries of a directory in the current project. \
                Path is relative to the project root (default: project root). Read-only.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Directory path relative to the project root. Defaults to '.'."
                    }
                }
            }),
        },
    ]
}

/// team 参加時に追加するツール定義 (Issue #1004)。pull 型: team_read で受信、team_send で
/// 送信、team_info で roster 把握。実行は team_hub の既存関数へ委譲する (別経路)。
pub(super) fn builtin_team_tools() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "team_read",
            description: "Read unread messages addressed to you in your team.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "unread_only": {
                        "type": "boolean",
                        "description": "Only return unread messages (default true)."
                    }
                }
            }),
        },
        ToolSpec {
            name: "team_send",
            description: "Send a message to a teammate or role in your team.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "to": {
                        "type": "string",
                        "description": "Recipient: a role name, an agent id, or 'all'."
                    },
                    "message": { "type": "string", "description": "Message body." }
                },
                "required": ["to", "message"]
            }),
        },
        ToolSpec {
            name: "team_info",
            description: "Get your team's roster, leader, and open tasks. No arguments.",
            parameters: json!({ "type": "object", "properties": {} }),
        },
    ]
}

/// team 系 tool 名か。`execute_tool` ではなく team_hub 経由で実行する。
pub(super) fn is_team_tool(name: &str) -> bool {
    matches!(name, "team_read" | "team_send" | "team_info")
}

/// 名前でツールをディスパッチして実行する。未知ツールはエラー結果を返す。
pub(super) fn execute_tool(project_root: &str, name: &str, args: &Value) -> ToolOutcome {
    match name {
        "read_file" => read_file_tool(project_root, args),
        "list_dir" => list_dir_tool(project_root, args),
        other => ToolOutcome::err(format!("unknown tool: {other}")),
    }
}

/// `project_root` 配下に収まる実体パスへ解決する。canonicalize 後の実体が root 外を指す
/// (symlink escape / traversal) 場合はエラー。
fn resolve_within(project_root: &str, rel: &str) -> Result<PathBuf, String> {
    let root = project_root.trim();
    if root.is_empty() {
        return Err("no project is open".to_string());
    }
    let root_canon =
        std::fs::canonicalize(root).map_err(|e| format!("project root unavailable: {e}"))?;
    // rel が絶対パスでも join で置換されるが、最終的な canonicalize + 封じ込めで弾く。
    let joined = root_canon.join(rel);
    let canon = std::fs::canonicalize(&joined).map_err(|e| format!("path not found: {rel} ({e})"))?;
    if !canon.starts_with(&root_canon) {
        return Err(format!("path escapes the project root: {rel}"));
    }
    Ok(canon)
}

fn read_file_tool(project_root: &str, args: &Value) -> ToolOutcome {
    let Some(path) = args.get("path").and_then(Value::as_str) else {
        return ToolOutcome::err("read_file requires a string 'path' argument");
    };
    let resolved = match resolve_within(project_root, path) {
        Ok(p) => p,
        Err(e) => return ToolOutcome::err(e),
    };
    let meta = match std::fs::metadata(&resolved) {
        Ok(m) => m,
        Err(e) => return ToolOutcome::err(format!("stat failed: {e}")),
    };
    if !meta.is_file() {
        return ToolOutcome::err(format!("not a file: {path}"));
    }
    // offset / limit が指定されたら行レンジ読み (大ファイルのページング)。
    let offset = args.get("offset").and_then(Value::as_u64);
    let limit = args.get("limit").and_then(Value::as_u64);
    if offset.is_some() || limit.is_some() {
        return read_file_range(&resolved, offset, limit);
    }
    use std::io::Read;
    let file = match std::fs::File::open(&resolved) {
        Ok(f) => f,
        Err(e) => return ToolOutcome::err(format!("open failed: {e}")),
    };
    let mut buf = Vec::new();
    if let Err(e) = file.take(MAX_READ_BYTES).read_to_end(&mut buf) {
        return ToolOutcome::err(format!("read failed: {e}"));
    }
    let mut text = String::from_utf8_lossy(&buf).to_string();
    if meta.len() > MAX_READ_BYTES {
        text.push_str("\n…(truncated; file exceeds 64KB read limit)");
    }
    ToolOutcome::ok(text)
}

/// 行レンジ読み: 1-based `offset` から `limit` 行 (既定 2000) を読む。出力は 64KB で truncate。
fn read_file_range(
    resolved: &std::path::Path,
    offset: Option<u64>,
    limit: Option<u64>,
) -> ToolOutcome {
    use std::io::{BufRead, BufReader};
    let start = offset.unwrap_or(1).max(1);
    let count = limit.unwrap_or(2000).max(1);
    let file = match std::fs::File::open(resolved) {
        Ok(f) => f,
        Err(e) => return ToolOutcome::err(format!("open failed: {e}")),
    };
    let reader = BufReader::new(file);
    let mut out = String::new();
    let mut emitted = 0u64;
    let mut truncated = false;
    for (idx, line) in reader.lines().enumerate() {
        let lineno = idx as u64 + 1;
        if lineno < start {
            continue;
        }
        if emitted >= count {
            break;
        }
        // I/O / 非 UTF-8 エラーは silent に空行へ潰さず、明示して打ち切る。
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                if emitted == 0 {
                    return ToolOutcome::err(format!("read failed at line {lineno}: {e}"));
                }
                out.push_str(&format!("…(read stopped at line {lineno}: {e})"));
                return ToolOutcome::ok(out);
            }
        };
        out.push_str(&line);
        out.push('\n');
        emitted += 1;
        if out.len() as u64 > MAX_READ_BYTES {
            truncated = true;
            break;
        }
    }
    if emitted == 0 {
        return ToolOutcome::ok(format!("(no lines at offset {start})"));
    }
    if truncated {
        out.push_str("…(truncated; exceeds 64KB read limit)");
    }
    ToolOutcome::ok(out)
}

fn list_dir_tool(project_root: &str, args: &Value) -> ToolOutcome {
    let path = args
        .get("path")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(".");
    let resolved = match resolve_within(project_root, path) {
        Ok(p) => p,
        Err(e) => return ToolOutcome::err(e),
    };
    if !resolved.is_dir() {
        return ToolOutcome::err(format!("not a directory: {path}"));
    }
    let rd = match std::fs::read_dir(&resolved) {
        Ok(rd) => rd,
        Err(e) => return ToolOutcome::err(format!("read_dir failed: {e}")),
    };
    // bounded top-K: 全件を Vec に貯めてソートするのではなく、アルファベット順で先頭
    // MAX_LIST_ENTRIES 件だけを max-heap で保持する。大量エントリのディレクトリでも
    // メモリ/ソートコストを K 件に抑える (O(n log K) / O(K))。
    use std::collections::BinaryHeap;
    let mut heap: BinaryHeap<String> = BinaryHeap::new();
    let mut total = 0usize;
    for e in rd.flatten() {
        total += 1;
        let name = e.file_name().to_string_lossy().to_string();
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        heap.push(if is_dir { format!("{name}/") } else { name });
        if heap.len() > MAX_LIST_ENTRIES {
            heap.pop(); // 最大要素を捨て、先頭 K 件 (アルファベット順) を保持
        }
    }
    let mut entries = heap.into_vec();
    entries.sort();
    let mut out = entries.join("\n");
    if total > MAX_LIST_ENTRIES {
        out.push_str(&format!(
            "\n…({} more entries truncated)",
            total - MAX_LIST_ENTRIES
        ));
    }
    if out.is_empty() {
        out.push_str("(empty directory)");
    }
    ToolOutcome::ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "hello world").unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        std::fs::write(dir.path().join("sub/b.txt"), "nested").unwrap();
        dir
    }

    #[test]
    fn read_file_reads_within_root() {
        let dir = setup();
        let root = dir.path().to_string_lossy().to_string();
        let out = execute_tool(&root, "read_file", &json!({ "path": "a.txt" }));
        assert!(!out.is_error);
        assert_eq!(out.content, "hello world");
        let nested = execute_tool(&root, "read_file", &json!({ "path": "sub/b.txt" }));
        assert_eq!(nested.content, "nested");
    }

    #[test]
    fn read_file_offset_limit_reads_slice() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        std::fs::write(dir.path().join("n.txt"), "L1\nL2\nL3\nL4\nL5\n").unwrap();
        let out = execute_tool(
            &root,
            "read_file",
            &json!({ "path": "n.txt", "offset": 2, "limit": 2 }),
        );
        assert!(!out.is_error, "{}", out.content);
        assert_eq!(out.content, "L2\nL3\n");
    }

    #[test]
    fn read_file_offset_past_end_is_empty_note() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        std::fs::write(dir.path().join("n.txt"), "L1\nL2\n").unwrap();
        let out = execute_tool(&root, "read_file", &json!({ "path": "n.txt", "offset": 99 }));
        assert!(!out.is_error);
        assert!(out.content.contains("no lines at offset"));
    }

    #[test]
    fn read_file_range_surfaces_non_utf8_error() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        std::fs::write(dir.path().join("bin.txt"), [0xff, 0xfe, 0x00, 0x01]).unwrap();
        let out = execute_tool(&root, "read_file", &json!({ "path": "bin.txt", "offset": 1 }));
        assert!(out.is_error);
        assert!(out.content.contains("read failed"), "{}", out.content);
    }

    #[test]
    fn read_file_limit_only_reads_head() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        std::fs::write(dir.path().join("n.txt"), "a\nb\nc\nd\n").unwrap();
        let out = execute_tool(&root, "read_file", &json!({ "path": "n.txt", "limit": 2 }));
        assert!(!out.is_error);
        assert_eq!(out.content, "a\nb\n");
    }

    #[test]
    fn read_file_rejects_traversal() {
        let dir = setup();
        let root = dir.path().join("sub").to_string_lossy().to_string();
        // sub の外 (../a.txt) は root=sub の外なので拒否される
        let out = execute_tool(&root, "read_file", &json!({ "path": "../a.txt" }));
        assert!(out.is_error);
        assert!(out.content.contains("escapes") || out.content.contains("not found"));
    }

    #[cfg(unix)]
    #[test]
    fn read_file_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;
        let dir = setup();
        // project root を sub にし、secret は sub の外 (project 直下) に置く
        let root = dir.path().join("sub");
        let secret = dir.path().join("secret.txt");
        std::fs::write(&secret, "TOP SECRET").unwrap();
        symlink(&secret, root.join("leak.txt")).unwrap();
        let out = execute_tool(
            &root.to_string_lossy(),
            "read_file",
            &json!({ "path": "leak.txt" }),
        );
        assert!(out.is_error);
        assert!(!out.content.contains("TOP SECRET"));
    }

    #[test]
    fn read_file_caps_size() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let big = "x".repeat((MAX_READ_BYTES as usize) * 2);
        std::fs::write(dir.path().join("big.txt"), &big).unwrap();
        let out = execute_tool(&root, "read_file", &json!({ "path": "big.txt" }));
        assert!(!out.is_error);
        assert!(out.content.contains("truncated"));
        assert!(out.content.len() <= MAX_READ_BYTES as usize + 100);
    }

    #[test]
    fn list_dir_lists_entries_and_marks_dirs() {
        let dir = setup();
        let root = dir.path().to_string_lossy().to_string();
        let out = execute_tool(&root, "list_dir", &json!({ "path": "." }));
        assert!(!out.is_error);
        assert!(out.content.contains("a.txt"));
        assert!(out.content.contains("sub/"));
    }

    #[test]
    fn list_dir_defaults_to_root() {
        let dir = setup();
        let root = dir.path().to_string_lossy().to_string();
        let out = execute_tool(&root, "list_dir", &json!({}));
        assert!(!out.is_error);
        assert!(out.content.contains("a.txt"));
    }

    #[test]
    fn list_dir_caps_entry_count_keeping_alphabetical_first() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        for i in 0..250 {
            std::fs::write(dir.path().join(format!("f{i:04}.txt")), "x").unwrap();
        }
        let out = execute_tool(&root, "list_dir", &json!({ "path": "." }));
        assert!(!out.is_error);
        assert!(out.content.contains("more entries truncated"));
        let entry_lines = out.content.lines().filter(|l| l.ends_with(".txt")).count();
        assert_eq!(entry_lines, MAX_LIST_ENTRIES);
        // アルファベット順で先頭が残り、末尾は truncate される
        assert!(out.content.contains("f0000.txt"));
        assert!(!out.content.contains("f0249.txt"));
    }

    #[test]
    fn unknown_tool_is_error() {
        let dir = setup();
        let out = execute_tool(&dir.path().to_string_lossy(), "rm_rf", &json!({}));
        assert!(out.is_error);
        assert!(out.content.contains("unknown tool"));
    }

    #[test]
    fn missing_path_arg_is_error() {
        let dir = setup();
        let out = execute_tool(&dir.path().to_string_lossy(), "read_file", &json!({}));
        assert!(out.is_error);
    }

    #[test]
    fn empty_project_root_is_error() {
        let out = execute_tool("", "list_dir", &json!({}));
        assert!(out.is_error);
        assert!(out.content.contains("no project"));
    }

    #[test]
    fn team_tools_are_recognized_and_listed() {
        assert!(is_team_tool("team_read"));
        assert!(is_team_tool("team_send"));
        assert!(is_team_tool("team_info"));
        assert!(!is_team_tool("read_file"));
        assert!(!is_team_tool("list_dir"));
        let names: Vec<&str> = builtin_team_tools().iter().map(|s| s.name).collect();
        assert_eq!(names, vec!["team_read", "team_send", "team_info"]);
    }

    #[test]
    fn execute_tool_does_not_handle_team_tools() {
        // team tool は execute_tool ではなく team_hub 経由なので、ここでは未知扱い。
        let dir = setup();
        let out = execute_tool(&dir.path().to_string_lossy(), "team_send", &json!({}));
        assert!(out.is_error);
        assert!(out.content.contains("unknown tool"));
    }
}

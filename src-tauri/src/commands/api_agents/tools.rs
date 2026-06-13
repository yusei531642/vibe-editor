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
                Path is relative to the project root. Read-only.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "File path relative to the project root."
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
}

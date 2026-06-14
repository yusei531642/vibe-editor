// api_agents/tools_write — API エージェントの workspace-write ツール (Issue #1031, Codex parity Phase 1)。
//
// スコープ: write_file / edit_file。安全モデルは **workspace-write**:
//   - 書込先は active project root 配下のみ許可。外は拒否 (将来は承認 UI / Phase 4)。
//   - 新規ファイル/ネストパスは「最深の既存祖先を canonicalize → root 配下を検証 → 残りの
//     非存在コンポーネントに `..` を許さない」方式で、symlink escape / traversal を封じ込める。
//   - 書込はサイズ上限でキャップし、tmp + rename の同期 atomic 書込で半端ファイルを避ける。
//
// 露出は auto 経路のみ。`api_agent_send` は toolMode==='readOnly' / tool 非対応 provider を
// tools=None (SSE chat) に degrade するため、write tool は tool-calling ループ (auto) のときだけ
// `tool_specs()` に追加される。
//
// ツール種別/結果型 (`ToolSpec` / `ToolOutcome`) は tools.rs と共有する。

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

use super::tools::{ToolOutcome, ToolSpec};

/// write_file / edit_file が書き込める最大バイト数。
const MAX_WRITE_BYTES: usize = 256 * 1024;

fn ok(content: impl Into<String>) -> ToolOutcome {
    ToolOutcome {
        content: content.into(),
        is_error: false,
    }
}
fn err(content: impl Into<String>) -> ToolOutcome {
    ToolOutcome {
        content: content.into(),
        is_error: true,
    }
}

/// write 系 tool 名か。`tools::execute_tool` ではなく `execute_write_tool` で実行する。
pub(super) fn is_write_tool(name: &str) -> bool {
    matches!(name, "write_file" | "edit_file")
}

/// auto 経路でモデルに公開する workspace-write ツール定義。
pub(super) fn builtin_write_tools() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "write_file",
            description: "Create or overwrite a UTF-8 text file in the current project. \
                Path is relative to the project root. Writes are confined to the project \
                root (workspace-write); paths outside it are rejected.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File path relative to the project root." },
                    "content": { "type": "string", "description": "Full file contents to write." }
                },
                "required": ["path", "content"]
            }),
        },
        ToolSpec {
            name: "edit_file",
            description: "Replace an exact text snippet in an existing file. \
                'old_string' must match exactly once (unless replace_all is true). \
                Path is relative to the project root and confined to it.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File path relative to the project root." },
                    "old_string": { "type": "string", "description": "Exact text to replace." },
                    "new_string": { "type": "string", "description": "Replacement text." },
                    "replace_all": {
                        "type": "boolean",
                        "description": "Replace every occurrence instead of requiring a unique match (default false)."
                    }
                },
                "required": ["path", "old_string", "new_string"]
            }),
        },
    ]
}

/// write 系 tool をディスパッチ実行する (同期 fs。caller が spawn_blocking で呼ぶ)。
pub(super) fn execute_write_tool(project_root: &str, name: &str, args: &Value) -> ToolOutcome {
    match name {
        "write_file" => write_file_tool(project_root, args),
        "edit_file" => edit_file_tool(project_root, args),
        other => err(format!("unknown write tool: {other}")),
    }
}

/// 書込先を project root 配下の実体パスへ解決する。新規 (非存在) パスも許容するが、
/// 最深の既存祖先を canonicalize して root 配下を確認し、非存在側に `..` を許さないことで
/// symlink escape / traversal を封じ込める。
fn resolve_within_writable(project_root: &str, rel: &str) -> Result<PathBuf, String> {
    let root = project_root.trim();
    if root.is_empty() {
        return Err("no project is open".to_string());
    }
    let root_canon =
        std::fs::canonicalize(root).map_err(|e| format!("project root unavailable: {e}"))?;
    let joined = root_canon.join(rel);

    // joined から上に辿り、最初に canonicalize できる (= 存在する) 祖先を探す。
    // 途中の非存在コンポーネントは tail に積む (逆順)。
    let mut cursor: &Path = joined.as_path();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let existing_canon = loop {
        match std::fs::canonicalize(cursor) {
            Ok(c) => break c,
            Err(_) => {
                let name = cursor
                    .file_name()
                    .ok_or_else(|| format!("invalid path: {rel}"))?;
                tail.push(name.to_os_string());
                cursor = cursor
                    .parent()
                    .ok_or_else(|| format!("invalid path: {rel}"))?;
            }
        }
    };
    if !existing_canon.starts_with(&root_canon) {
        return Err(format!("path escapes the project root: {rel}"));
    }
    // 非存在側コンポーネントを安全に積み直す (`.` は無視、`..` / 絶対は拒否)。
    let mut result = existing_canon;
    for comp in tail.iter().rev() {
        if comp == ".." || comp == "/" || comp == "." {
            if comp == "." {
                continue;
            }
            return Err(format!("path escapes the project root: {rel}"));
        }
        result.push(comp);
    }
    if !result.starts_with(&root_canon) {
        return Err(format!("path escapes the project root: {rel}"));
    }
    Ok(result)
}

/// tmp に書いて rename する同期 atomic 書込。半端な内容が残らないようにする。
fn write_atomic(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let fname = target
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("vibe");
    let tmp = parent.join(format!(".{fname}.tmp.{}", std::process::id()));
    if let Err(e) = std::fs::write(&tmp, bytes) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = std::fs::rename(&tmp, target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

fn write_file_tool(project_root: &str, args: &Value) -> ToolOutcome {
    let Some(path) = args.get("path").and_then(Value::as_str) else {
        return err("write_file requires a string 'path' argument");
    };
    let Some(content) = args.get("content").and_then(Value::as_str) else {
        return err("write_file requires a string 'content' argument");
    };
    if content.len() > MAX_WRITE_BYTES {
        return err(format!(
            "content too large: {} bytes (limit {MAX_WRITE_BYTES})",
            content.len()
        ));
    }
    let resolved = match resolve_within_writable(project_root, path) {
        Ok(p) => p,
        Err(e) => return err(e),
    };
    if resolved.is_dir() {
        return err(format!("path is a directory: {path}"));
    }
    if let Some(parent) = resolved.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return err(format!("create parent directory failed: {e}"));
        }
    }
    match write_atomic(&resolved, content.as_bytes()) {
        Ok(()) => ok(format!("wrote {} bytes to {path}", content.len())),
        Err(e) => err(format!("write failed: {e}")),
    }
}

fn edit_file_tool(project_root: &str, args: &Value) -> ToolOutcome {
    let Some(path) = args.get("path").and_then(Value::as_str) else {
        return err("edit_file requires a string 'path' argument");
    };
    let Some(old_string) = args.get("old_string").and_then(Value::as_str) else {
        return err("edit_file requires a string 'old_string' argument");
    };
    let Some(new_string) = args.get("new_string").and_then(Value::as_str) else {
        return err("edit_file requires a string 'new_string' argument");
    };
    if old_string.is_empty() {
        return err("edit_file 'old_string' must not be empty");
    }
    let replace_all = args
        .get("replace_all")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    // 編集対象は既存ファイルのみ。resolve_within_writable は新規も許容するが、ここでは
    // 存在チェックで弾く (新規作成は write_file の責務)。
    let resolved = match resolve_within_writable(project_root, path) {
        Ok(p) => p,
        Err(e) => return err(e),
    };
    if !resolved.is_file() {
        return err(format!("not a file: {path}"));
    }
    let content = match std::fs::read_to_string(&resolved) {
        Ok(c) => c,
        Err(e) => return err(format!("read failed (not UTF-8?): {e}")),
    };
    let count = content.matches(old_string).count();
    if count == 0 {
        return err(format!("old_string not found in {path}"));
    }
    if !replace_all && count > 1 {
        return err(format!(
            "old_string is not unique in {path} ({count} matches); pass replace_all or add more context"
        ));
    }
    let updated = if replace_all {
        content.replace(old_string, new_string)
    } else {
        content.replacen(old_string, new_string, 1)
    };
    if updated.len() > MAX_WRITE_BYTES {
        return err(format!(
            "result too large: {} bytes (limit {MAX_WRITE_BYTES})",
            updated.len()
        ));
    }
    match write_atomic(&resolved, updated.as_bytes()) {
        Ok(()) => ok(format!(
            "edited {path} ({} replacement{})",
            if replace_all { count } else { 1 },
            if (if replace_all { count } else { 1 }) == 1 { "" } else { "s" }
        )),
        Err(e) => err(format!("write failed: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "hello world").unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        dir
    }

    #[test]
    fn write_file_creates_within_root() {
        let dir = setup();
        let root = dir.path().to_string_lossy().to_string();
        let out = execute_write_tool(
            &root,
            "write_file",
            &json!({ "path": "new.txt", "content": "hi" }),
        );
        assert!(!out.is_error, "{}", out.content);
        assert_eq!(std::fs::read_to_string(dir.path().join("new.txt")).unwrap(), "hi");
    }

    #[test]
    fn write_file_creates_nested_dirs() {
        let dir = setup();
        let root = dir.path().to_string_lossy().to_string();
        let out = execute_write_tool(
            &root,
            "write_file",
            &json!({ "path": "a/b/c.txt", "content": "x" }),
        );
        assert!(!out.is_error, "{}", out.content);
        assert_eq!(std::fs::read_to_string(dir.path().join("a/b/c.txt")).unwrap(), "x");
    }

    #[test]
    fn write_file_overwrites() {
        let dir = setup();
        let root = dir.path().to_string_lossy().to_string();
        let out = execute_write_tool(
            &root,
            "write_file",
            &json!({ "path": "a.txt", "content": "replaced" }),
        );
        assert!(!out.is_error);
        assert_eq!(std::fs::read_to_string(dir.path().join("a.txt")).unwrap(), "replaced");
    }

    #[test]
    fn write_file_rejects_outside_workspace() {
        let dir = setup();
        // root を sub にして親 (../escape.txt) への書込を拒否する
        let root = dir.path().join("sub").to_string_lossy().to_string();
        let out = execute_write_tool(
            &root,
            "write_file",
            &json!({ "path": "../escape.txt", "content": "leak" }),
        );
        assert!(out.is_error);
        assert!(out.content.contains("escapes"));
        assert!(!dir.path().join("escape.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn write_file_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;
        let dir = setup();
        let root = dir.path().join("sub");
        // sub/outdir -> dir (project root の外) への symlink
        let outside = dir.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        symlink(&outside, root.join("link")).unwrap();
        let out = execute_write_tool(
            &root.to_string_lossy(),
            "write_file",
            &json!({ "path": "link/x.txt", "content": "leak" }),
        );
        assert!(out.is_error);
        assert!(!outside.join("x.txt").exists());
    }

    #[test]
    fn write_file_caps_size() {
        let dir = setup();
        let root = dir.path().to_string_lossy().to_string();
        let big = "x".repeat(MAX_WRITE_BYTES + 1);
        let out = execute_write_tool(
            &root,
            "write_file",
            &json!({ "path": "big.txt", "content": big }),
        );
        assert!(out.is_error);
        assert!(out.content.contains("too large"));
    }

    #[test]
    fn edit_file_unique_match() {
        let dir = setup();
        let root = dir.path().to_string_lossy().to_string();
        let out = execute_write_tool(
            &root,
            "edit_file",
            &json!({ "path": "a.txt", "old_string": "world", "new_string": "rust" }),
        );
        assert!(!out.is_error, "{}", out.content);
        assert_eq!(std::fs::read_to_string(dir.path().join("a.txt")).unwrap(), "hello rust");
    }

    #[test]
    fn edit_file_rejects_ambiguous() {
        let dir = setup();
        let root = dir.path().to_string_lossy().to_string();
        std::fs::write(dir.path().join("dup.txt"), "x x x").unwrap();
        let out = execute_write_tool(
            &root,
            "edit_file",
            &json!({ "path": "dup.txt", "old_string": "x", "new_string": "y" }),
        );
        assert!(out.is_error);
        assert!(out.content.contains("not unique"));
    }

    #[test]
    fn edit_file_replace_all() {
        let dir = setup();
        let root = dir.path().to_string_lossy().to_string();
        std::fs::write(dir.path().join("dup.txt"), "x x x").unwrap();
        let out = execute_write_tool(
            &root,
            "edit_file",
            &json!({ "path": "dup.txt", "old_string": "x", "new_string": "y", "replace_all": true }),
        );
        assert!(!out.is_error, "{}", out.content);
        assert_eq!(std::fs::read_to_string(dir.path().join("dup.txt")).unwrap(), "y y y");
    }

    #[test]
    fn edit_file_not_found_string() {
        let dir = setup();
        let root = dir.path().to_string_lossy().to_string();
        let out = execute_write_tool(
            &root,
            "edit_file",
            &json!({ "path": "a.txt", "old_string": "zzz", "new_string": "y" }),
        );
        assert!(out.is_error);
        assert!(out.content.contains("not found"));
    }

    #[test]
    fn edit_file_requires_existing_file() {
        let dir = setup();
        let root = dir.path().to_string_lossy().to_string();
        let out = execute_write_tool(
            &root,
            "edit_file",
            &json!({ "path": "nope.txt", "old_string": "a", "new_string": "b" }),
        );
        assert!(out.is_error);
        assert!(out.content.contains("not a file"));
    }

    #[test]
    fn is_write_tool_recognizes_names() {
        assert!(is_write_tool("write_file"));
        assert!(is_write_tool("edit_file"));
        assert!(!is_write_tool("read_file"));
        assert!(!is_write_tool("team_send"));
        let names: Vec<&str> = builtin_write_tools().iter().map(|s| s.name).collect();
        assert_eq!(names, vec!["write_file", "edit_file"]);
    }

    #[test]
    fn empty_project_root_is_error() {
        let out = execute_write_tool("", "write_file", &json!({ "path": "x", "content": "y" }));
        assert!(out.is_error);
        assert!(out.content.contains("no project"));
    }
}

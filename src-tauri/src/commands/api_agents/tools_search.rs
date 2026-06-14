// api_agents/tools_search — 検索ツール grep / glob (Issue #1036, Codex parity Phase 2b)。
//
// grep (literal substring) / glob (* ? ** 簡易マッチャ)。read-only・依存追加なし (std のみ)。
// 安全モデル: canonicalize 封じ込めで project root 配下のみ走査。symlink は非追従。露出は auto
// 経路のみ。VCS/ビルド生成物 dir と バイナリ/大ファイルを skip し、結果は件数上限で truncate。

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

use super::tools::{ToolOutcome, ToolSpec};

/// grep が読む 1 ファイルの最大バイト数 (超過は skip)。
const MAX_FILE_BYTES: u64 = 1024 * 1024;
/// grep が返す最大マッチ行数。
const MAX_MATCHES: usize = 200;
/// glob が返す最大パス数。
const MAX_GLOB_RESULTS: usize = 300;
/// 表示する 1 行の最大文字数。
const MAX_LINE_CHARS: usize = 240;
const MAX_WALK_ENTRIES: usize = 50_000; // 走査エントリ総数の安全上限 (暴走防止)

/// 走査時に降りないディレクトリ名 (VCS / 依存 / ビルド生成物)。
const IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".svelte-kit",
    ".turbo",
    "coverage",
    "vendor",
    ".venv",
    "__pycache__",
];

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

/// search 系 tool 名か。read/write/exec/team とは別 dispatch。
pub(super) fn is_search_tool(name: &str) -> bool {
    matches!(name, "grep" | "glob")
}

/// auto 経路でモデルに公開する検索ツール定義。
pub(super) fn builtin_search_tools() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "grep",
            description: "Search file contents in the current project for a literal substring. \
                Returns matching lines as 'path:line: text'. Read-only; confined to the project \
                root. Skips VCS/build directories and binary/large files. Results are capped.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "Literal substring to search for (not a regex)." },
                    "path": { "type": "string", "description": "Subdirectory to search, relative to project root (default '.')." },
                    "glob": { "type": "string", "description": "Optional filename glob filter, e.g. '*.rs' or '**/*.ts'." }
                },
                "required": ["pattern"]
            }),
        },
        ToolSpec {
            name: "glob",
            description: "List files in the current project whose path matches a glob pattern \
                (* ? and ** supported). Read-only; confined to the project root. Results are capped.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "Glob pattern relative to project root, e.g. '**/*.rs' or 'src/*.ts'." }
                },
                "required": ["pattern"]
            }),
        },
    ]
}

/// search 系 tool をディスパッチ実行する (同期 fs。caller が spawn_blocking で呼ぶ)。
pub(super) fn execute_search_tool(project_root: &str, name: &str, args: &Value) -> ToolOutcome {
    match name {
        "grep" => grep_tool(project_root, args),
        "glob" => glob_tool(project_root, args),
        other => err(format!("unknown search tool: {other}")),
    }
}

/// project root を canonicalize して返す。
fn canon_root(project_root: &str) -> Result<PathBuf, String> {
    let root = project_root.trim();
    if root.is_empty() {
        return Err("no project is open".to_string());
    }
    std::fs::canonicalize(root).map_err(|e| format!("project root unavailable: {e}"))
}

/// `rel` を root 配下の既存パスへ解決する (read 用 / canonicalize 封じ込め)。
fn resolve_within(root_canon: &Path, rel: &str) -> Result<PathBuf, String> {
    let joined = root_canon.join(rel);
    let canon = std::fs::canonicalize(&joined).map_err(|e| format!("path not found: {rel} ({e})"))?;
    if !canon.starts_with(root_canon) {
        return Err(format!("path escapes the project root: {rel}"));
    }
    Ok(canon)
}

/// root 配下を walk して (相対パス文字列, 絶対パス) を visitor に渡す。ignored dir は降りない。
/// visitor が false を返すと打ち切る。総数は MAX_WALK_ENTRIES で安全上限。
fn walk(root_canon: &Path, start: &Path, mut visit: impl FnMut(&str, &Path) -> bool) {
    let mut stack = vec![start.to_path_buf()];
    let mut seen = 0usize;
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in rd.flatten() {
            seen += 1;
            if seen > MAX_WALK_ENTRIES {
                return;
            }
            let file_type = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            // 封じ込め (Critical): symlink は dir/file いずれも辿らない。`fs::metadata`/`fs::read`
            // が symlink を follow して root 外 (例 ~/.ssh/id_rsa) を読み出すのを防ぐ。
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if file_type.is_dir() {
                if IGNORED_DIRS.contains(&name.as_str()) {
                    continue;
                }
                stack.push(path);
            } else {
                let rel = path
                    .strip_prefix(root_canon)
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_else(|_| name.clone());
                if !visit(&rel, &path) {
                    return;
                }
            }
        }
    }
}

fn grep_tool(project_root: &str, args: &Value) -> ToolOutcome {
    let root_canon = match canon_root(project_root) {
        Ok(p) => p,
        Err(e) => return err(e),
    };
    let Some(pattern) = args.get("pattern").and_then(Value::as_str) else {
        return err("grep requires a string 'pattern' argument");
    };
    if pattern.is_empty() {
        return err("grep 'pattern' must not be empty");
    }
    let sub = args
        .get("path")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(".");
    let start = match resolve_within(&root_canon, sub) {
        Ok(p) => p,
        Err(e) => return err(e),
    };
    let glob_filter = args
        .get("glob")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(|g| normalize_glob_owned(g.split('/').map(str::to_string).collect::<Vec<_>>()));

    let mut out: Vec<String> = Vec::new();
    let mut truncated = false;
    walk(&root_canon, &start, |rel, abs| {
        if let Some(ref segs) = glob_filter {
            let path_segs: Vec<&str> = rel.split('/').collect();
            let seg_refs: Vec<&str> = segs.iter().map(String::as_str).collect();
            if !glob_match(&seg_refs, &path_segs) {
                return true;
            }
        }
        let Ok(meta) = std::fs::metadata(abs) else {
            return true;
        };
        if meta.len() > MAX_FILE_BYTES {
            return true;
        }
        let Ok(bytes) = std::fs::read(abs) else {
            return true;
        };
        if bytes.contains(&0) {
            return true; // binary
        }
        let content = String::from_utf8_lossy(&bytes);
        for (i, line) in content.lines().enumerate() {
            if line.contains(pattern) {
                out.push(format!("{rel}:{}: {}", i + 1, truncate_line(line)));
                if out.len() >= MAX_MATCHES {
                    truncated = true;
                    return false;
                }
            }
        }
        true
    });

    if out.is_empty() {
        return ok(format!("no matches for '{pattern}'"));
    }
    let mut text = out.join("\n");
    if truncated {
        text.push_str(&format!("\n…(truncated at {MAX_MATCHES} matches)"));
    }
    ok(text)
}

fn glob_tool(project_root: &str, args: &Value) -> ToolOutcome {
    let root_canon = match canon_root(project_root) {
        Ok(p) => p,
        Err(e) => return err(e),
    };
    let Some(pattern) = args.get("pattern").and_then(Value::as_str) else {
        return err("glob requires a string 'pattern' argument");
    };
    if pattern.trim().is_empty() {
        return err("glob 'pattern' must not be empty");
    }
    let raw_segs: Vec<&str> = pattern.trim_start_matches("./").split('/').collect();
    let pat_segs = normalize_glob(&raw_segs);

    let mut out: Vec<String> = Vec::new();
    let mut truncated = false;
    let root = root_canon.clone();
    walk(&root_canon, &root, |rel, _abs| {
        let path_segs: Vec<&str> = rel.split('/').collect();
        if glob_match(&pat_segs, &path_segs) {
            out.push(rel.to_string());
            if out.len() >= MAX_GLOB_RESULTS {
                truncated = true;
                return false;
            }
        }
        true
    });

    if out.is_empty() {
        return ok(format!("no files match '{pattern}'"));
    }
    out.sort();
    let mut text = out.join("\n");
    if truncated {
        text.push_str(&format!("\n…(truncated at {MAX_GLOB_RESULTS} results)"));
    }
    ok(text)
}

fn truncate_line(line: &str) -> String {
    let trimmed = line.trim_end();
    if trimmed.chars().count() > MAX_LINE_CHARS {
        let s: String = trimmed.chars().take(MAX_LINE_CHARS).collect();
        format!("{s}…")
    } else {
        trimmed.to_string()
    }
}

/// 連続する `**` を 1 個に畳む (意味は等価)。`**/**/**` 等での glob_match の O(d^k) 再帰爆発を
/// 緩和する (Performance)。借用版。
fn normalize_glob<'a>(segs: &[&'a str]) -> Vec<&'a str> {
    let mut out: Vec<&str> = Vec::with_capacity(segs.len());
    for &s in segs {
        if s == "**" && out.last() == Some(&"**") {
            continue;
        }
        out.push(s);
    }
    out
}

/// `normalize_glob` の所有版 (grep の glob filter 用)。
fn normalize_glob_owned(segs: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(segs.len());
    for s in segs {
        if s == "**" && out.last().map(String::as_str) == Some("**") {
            continue;
        }
        out.push(s);
    }
    out
}

/// パスセグメント列をパターンセグメント列にマッチさせる。`**` は 0 個以上のセグメントに一致。
fn glob_match(pattern: &[&str], path: &[&str]) -> bool {
    match pattern.split_first() {
        None => path.is_empty(),
        Some((&"**", rest)) => {
            // 0 個以上のセグメントを消費して残りを試す。
            (0..=path.len()).any(|i| glob_match(rest, &path[i..]))
        }
        Some((seg, rest)) => {
            if path.is_empty() {
                return false;
            }
            segment_match(seg, path[0]) && glob_match(rest, &path[1..])
        }
    }
}

/// 1 セグメント内の `*` (任意・`/` を除く) / `?` (1 文字) ワイルドカードマッチ。
fn segment_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut mark) = (None::<usize>, 0usize);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.rs"), "fn main() {\n    let todo = 1;\n}\n").unwrap();
        std::fs::create_dir(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/lib.rs"), "// TODO: implement\npub fn f() {}\n").unwrap();
        std::fs::create_dir(dir.path().join("node_modules")).unwrap();
        std::fs::write(dir.path().join("node_modules/x.rs"), "TODO should be skipped").unwrap();
        dir
    }

    #[test]
    fn grep_finds_substring_with_path_and_line() {
        let dir = setup();
        let root = dir.path().to_string_lossy().to_string();
        let out = execute_search_tool(&root, "grep", &json!({ "pattern": "TODO" }));
        assert!(!out.is_error, "{}", out.content);
        assert!(out.content.contains("src/lib.rs:1:"));
        // node_modules は skip される
        assert!(!out.content.contains("node_modules"));
    }

    #[test]
    fn grep_no_match() {
        let dir = setup();
        let root = dir.path().to_string_lossy().to_string();
        let out = execute_search_tool(&root, "grep", &json!({ "pattern": "zzzznope" }));
        assert!(!out.is_error);
        assert!(out.content.contains("no matches"));
    }

    #[test]
    fn grep_glob_filter() {
        let dir = setup();
        let root = dir.path().to_string_lossy().to_string();
        let out = execute_search_tool(
            &root,
            "grep",
            &json!({ "pattern": "fn", "glob": "src/*.rs" }),
        );
        assert!(!out.is_error, "{}", out.content);
        assert!(out.content.contains("src/lib.rs"));
        assert!(!out.content.contains("a.rs:"));
    }

    #[test]
    fn grep_rejects_outside_root() {
        let dir = setup();
        let root = dir.path().join("src").to_string_lossy().to_string();
        let out = execute_search_tool(&root, "grep", &json!({ "pattern": "x", "path": "../" }));
        assert!(out.is_error);
    }

    #[test]
    fn glob_matches_double_star() {
        let dir = setup();
        let root = dir.path().to_string_lossy().to_string();
        let out = execute_search_tool(&root, "glob", &json!({ "pattern": "**/*.rs" }));
        assert!(!out.is_error, "{}", out.content);
        assert!(out.content.contains("a.rs"));
        assert!(out.content.contains("src/lib.rs"));
        assert!(!out.content.contains("node_modules"));
    }

    #[test]
    fn glob_matches_single_segment() {
        let dir = setup();
        let root = dir.path().to_string_lossy().to_string();
        let out = execute_search_tool(&root, "glob", &json!({ "pattern": "*.rs" }));
        assert!(!out.is_error);
        assert!(out.content.contains("a.rs"));
        // src/lib.rs は 1 セグメントパターンに一致しない
        assert!(!out.content.contains("src/lib.rs"));
    }

    #[test]
    fn glob_no_match() {
        let dir = setup();
        let root = dir.path().to_string_lossy().to_string();
        let out = execute_search_tool(&root, "glob", &json!({ "pattern": "**/*.py" }));
        assert!(!out.is_error);
        assert!(out.content.contains("no files match"));
    }

    #[test]
    fn segment_match_wildcards() {
        assert!(segment_match("*.rs", "a.rs"));
        assert!(segment_match("a?c", "abc"));
        assert!(!segment_match("a?c", "ac"));
        assert!(segment_match("*", "anything"));
        assert!(segment_match("foo*bar", "fooXYZbar"));
        assert!(!segment_match("*.rs", "a.ts"));
    }

    #[test]
    fn glob_match_double_star_zero_segments() {
        assert!(glob_match(&["**", "*.rs"], &["a.rs"]));
        assert!(glob_match(&["**", "*.rs"], &["src", "a.rs"]));
        assert!(glob_match(&["src", "**", "*.rs"], &["src", "x", "y", "z.rs"]));
        assert!(!glob_match(&["src", "*.rs"], &["lib", "a.rs"]));
    }

    #[test]
    fn is_search_tool_recognizes_names() {
        assert!(is_search_tool("grep"));
        assert!(is_search_tool("glob"));
        assert!(!is_search_tool("read_file"));
        let names: Vec<&str> = builtin_search_tools().iter().map(|s| s.name).collect();
        assert_eq!(names, vec!["grep", "glob"]);
    }

    #[test]
    fn empty_project_root_is_error() {
        let out = execute_search_tool("", "grep", &json!({ "pattern": "x" }));
        assert!(out.is_error);
        assert!(out.content.contains("no project"));
    }

    #[test]
    fn normalize_glob_collapses_consecutive_double_star() {
        assert_eq!(normalize_glob(&["**", "**", "*.rs"]), vec!["**", "*.rs"]);
        // 非連続の ** は保持し、畳んでも意味は等価。
        assert_eq!(normalize_glob(&["**", "a", "**", "b"]), vec!["**", "a", "**", "b"]);
        assert!(glob_match(&normalize_glob(&["**", "**", "*.rs"]), &["x", "y", "z.rs"]));
    }

    // Critical fix: walk() が symlink を辿って root 外を読み出さないこと (grep/glob 共通の walk)。
    #[cfg(unix)]
    #[test]
    fn grep_does_not_follow_symlink_out_of_root() {
        use std::os::unix::fs::symlink;
        let dir = setup();
        let secret = dir.path().join("secret.txt");
        std::fs::write(&secret, "TOP_SECRET_TOKEN").unwrap();
        let root = dir.path().join("src");
        symlink(&secret, root.join("leak.txt")).unwrap();
        let out = execute_search_tool(
            &root.to_string_lossy(),
            "grep",
            &json!({ "pattern": "TOP_SECRET_TOKEN" }),
        );
        assert!(!out.is_error, "{}", out.content);
        // 漏洩していればマッチ行 "leak.txt:" が出る。symlink 非追従なので no matches。
        assert!(!out.content.contains("leak.txt:"), "{}", out.content);
    }
}

// api_agents/project_docs — AGENTS.md / CLAUDE.md の階層読み込み (Issue #1038, Codex parity Phase 3)。
//
// OpenAI Codex の AGENTS.md 機構相当を最小実装する。project root から cwd まで各階層の
// `AGENTS.md` (無ければ同階層の `CLAUDE.md` を fallback) を root→cwd 順で連結し、API agent の
// system prompt に project instructions として注入する。
//
// 封じ込め: canonicalize して cwd が root 配下のときだけ各階層を辿る。外なら root のみ。
// 合計 32KiB 上限 (Codex の project_doc_max_bytes 相当) で char 境界 truncate。

use std::path::{Path, PathBuf};

/// 各 project-doc 間のセパレータ。
const SEPARATOR: &str = "\n\n--- project-doc ---\n\n";
/// 注入する project docs 合計の最大バイト数。
const MAX_TOTAL_BYTES: usize = 32 * 1024;
/// 各階層で探すファイル名 (先頭優先。AGENTS.md が無ければ CLAUDE.md)。
const DOC_NAMES: &[&str] = &["AGENTS.md", "CLAUDE.md"];

/// project root → cwd の各階層の project doc を連結して返す (async)。
/// 同期 fs を複数回呼ぶため spawn_blocking で実行し、async コマンドをブロックしない (Performance)。
pub(super) async fn load_project_docs(project_root: &str, cwd: &str) -> Option<String> {
    let root = project_root.to_string();
    let cwd = cwd.to_string();
    tokio::task::spawn_blocking(move || load_project_docs_blocking(&root, &cwd))
        .await
        .ok()
        .flatten()
}

/// 同期実装。project root → cwd の各階層の project doc を連結して返す。無ければ None。
fn load_project_docs_blocking(project_root: &str, cwd: &str) -> Option<String> {
    let root = project_root.trim();
    if root.is_empty() {
        return None;
    }
    let root_canon = std::fs::canonicalize(root).ok()?;
    let cwd_input = if cwd.trim().is_empty() { root } else { cwd.trim() };
    let cwd_canon = std::fs::canonicalize(cwd_input).unwrap_or_else(|_| root_canon.clone());
    // 封じ込め: cwd が root 配下のときだけ階層を辿る。外なら root のみ。
    let chain = if cwd_canon.starts_with(&root_canon) {
        dir_chain(&root_canon, &cwd_canon)
    } else {
        vec![root_canon.clone()]
    };

    let mut parts: Vec<String> = Vec::new();
    let mut total = 0usize;
    for dir in chain {
        for name in DOC_NAMES {
            let p = dir.join(name);
            // 封じ込め (Security): symlink は follow しない。悪意ある repo が AGENTS.md を
            // 秘密ファイルへの symlink にして system prompt 経由で LLM に漏洩させるのを防ぐ。
            if std::fs::symlink_metadata(&p)
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false)
            {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&p) else {
                continue;
            };
            let rel = dir
                .strip_prefix(&root_canon)
                .ok()
                .map(|r| r.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            let label = if rel.is_empty() {
                name.to_string()
            } else {
                format!("{rel}/{name}")
            };
            let body = format!("# {label}\n\n{}", text.trim());
            total += body.len() + SEPARATOR.len();
            parts.push(body);
            break; // この階層は最優先で見つかった 1 ファイルだけ採る
        }
        if total >= MAX_TOTAL_BYTES {
            break;
        }
    }

    if parts.is_empty() {
        return None;
    }
    let mut joined = parts.join(SEPARATOR);
    if joined.len() > MAX_TOTAL_BYTES {
        let mut end = MAX_TOTAL_BYTES;
        while end > 0 && !joined.is_char_boundary(end) {
            end -= 1;
        }
        joined.truncate(end);
        joined.push_str("\n…(project docs truncated at 32KB)");
    }
    Some(joined)
}

/// root から cwd までのディレクトリ列 (root, root/a, …, cwd)。cwd==root なら [root]。
fn dir_chain(root: &Path, cwd: &Path) -> Vec<PathBuf> {
    let mut chain = vec![root.to_path_buf()];
    if let Ok(rel) = cwd.strip_prefix(root) {
        let mut cur = root.to_path_buf();
        for comp in rel.components() {
            cur = cur.join(comp);
            chain.push(cur.clone());
        }
    }
    chain
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_root_agents_md() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("AGENTS.md"), "root rules").unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let out = load_project_docs_blocking(&root, &root).unwrap();
        assert!(out.contains("# AGENTS.md"));
        assert!(out.contains("root rules"));
    }

    #[test]
    fn falls_back_to_claude_md() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("CLAUDE.md"), "claude rules").unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let out = load_project_docs_blocking(&root, &root).unwrap();
        assert!(out.contains("# CLAUDE.md"));
        assert!(out.contains("claude rules"));
    }

    #[test]
    fn prefers_agents_md_over_claude_md() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("AGENTS.md"), "AGENTS wins").unwrap();
        std::fs::write(dir.path().join("CLAUDE.md"), "claude loses").unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let out = load_project_docs_blocking(&root, &root).unwrap();
        assert!(out.contains("AGENTS wins"));
        assert!(!out.contains("claude loses"));
    }

    #[test]
    fn concatenates_hierarchy_root_first() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("AGENTS.md"), "ROOT_DOC").unwrap();
        let sub = dir.path().join("a/b");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("AGENTS.md"), "LEAF_DOC").unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let cwd = sub.to_string_lossy().to_string();
        let out = load_project_docs_blocking(&root, &cwd).unwrap();
        let ri = out.find("ROOT_DOC").unwrap();
        let li = out.find("LEAF_DOC").unwrap();
        assert!(ri < li, "root doc must come before leaf doc");
        assert!(out.contains("a/b/AGENTS.md"));
    }

    #[test]
    fn returns_none_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        assert!(load_project_docs_blocking(&root, &root).is_none());
    }

    #[test]
    fn empty_root_is_none() {
        assert!(load_project_docs_blocking("", "").is_none());
    }

    #[test]
    fn cwd_outside_root_uses_root_only() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("AGENTS.md"), "ROOT_ONLY").unwrap();
        let root = dir.path().join("inner");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("AGENTS.md"), "INNER_ROOT").unwrap();
        // cwd を root の外 (project 直下) にする → root(inner) のみが対象
        let out = load_project_docs_blocking(
            &root.to_string_lossy(),
            &dir.path().to_string_lossy(),
        )
        .unwrap();
        assert!(out.contains("INNER_ROOT"));
        assert!(!out.contains("ROOT_ONLY"));
    }

    // Security fix: AGENTS.md が root 外への symlink でも追跡しない。
    #[cfg(unix)]
    #[test]
    fn does_not_follow_symlinked_doc() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let secret = dir.path().join("secret.txt");
        std::fs::write(&secret, "SECRET_LEAK").unwrap();
        let root = dir.path().join("proj");
        std::fs::create_dir(&root).unwrap();
        symlink(&secret, root.join("AGENTS.md")).unwrap();
        let out = load_project_docs_blocking(&root.to_string_lossy(), &root.to_string_lossy());
        // symlink を follow しないので doc 無し扱い (None)。
        assert!(out.is_none());
    }

    #[test]
    fn truncates_at_size_limit() {
        let dir = tempfile::tempdir().unwrap();
        let big = "x".repeat(MAX_TOTAL_BYTES * 2);
        std::fs::write(dir.path().join("AGENTS.md"), &big).unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let out = load_project_docs_blocking(&root, &root).unwrap();
        assert!(out.contains("truncated"));
        assert!(out.len() <= MAX_TOTAL_BYTES + 100);
    }
}

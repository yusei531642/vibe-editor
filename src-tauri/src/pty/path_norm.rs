// path normalization helpers — Claude project ディレクトリの encoding と
// team_history / sessions / watcher の project root 比較で共有する。
//
// Issue #31, #32 関連の fix はこのモジュールにまとめ、複数箇所の実装ブレをなくす。

use std::path::Path;

/// Claude Code が使う encoding: 非 ASCII 英数字を `-` に置換する。
/// `~/.claude/projects/<encode_project_path(root)>/` ディレクトリ名の生成に使う。
///
/// **重要:** 単純置換なので別 path が同じ encoded 文字列に潰れうる (Issue #31)。
/// 衝突は jsonl 内の `cwd` を読んで filter することで補償する。
pub fn encode_project_path(root: &str) -> String {
    root.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// project root 比較用の正規化文字列を返す (Issue #32)。
///
/// 戦略:
///   1. canonicalize() が通れば (実体が存在すれば) それを採用
///   2. 失敗時は raw 文字列を次のルールで整形:
///      - `\\` → `/`
///      - 末尾区切り削除
///      - Windows では小文字化
///
/// 同一 project の raw 表記揺れ (大文字小文字、`\` vs `/`、trailing slash) を吸収する。
pub fn normalize_project_root(raw: &str) -> String {
    if raw.is_empty() {
        return String::new();
    }
    if let Ok(canonical) = Path::new(raw).canonicalize() {
        let s = canonical.to_string_lossy().replace('\\', "/");
        let stripped = s.trim_end_matches('/');
        return if cfg!(windows) {
            stripped.to_lowercase()
        } else {
            stripped.to_string()
        };
    }
    let normalized = raw.replace('\\', "/");
    let stripped = normalized.trim_end_matches('/');
    if cfg!(windows) {
        stripped.to_lowercase()
    } else {
        stripped.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_collision_is_still_possible() {
        // Issue #31 の論点: 単純置換の欠点を明示する回帰テスト
        assert_eq!(encode_project_path("C:\\repo-a"), encode_project_path("C--repo-a"));
    }

    #[test]
    fn trims_trailing_separator() {
        assert_eq!(
            normalize_project_root("/home/user/repo/"),
            normalize_project_root("/home/user/repo")
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_case_insensitive_normalization() {
        assert_eq!(normalize_project_root("D:/Repo"), normalize_project_root("d:\\repo"));
    }

    /// Issue #662: cross-OS で `~/.claude/projects/<encoded>/` のディレクトリ名が
    /// 公式 Claude CLI の規則 (= ASCII alnum 以外を `-`) と一致することを実機検証で
    /// 確定した値で固定する。jsonl のパス計算が renderer 側 / watcher 側 / 将来の
    /// renderer UI で必ず同じ値になるよう、回帰テストとして残す。
    #[test]
    fn encode_project_path_matches_official_claude_directory_layout() {
        // Windows: ドライブ文字 + `\`、`:` と `\` がそれぞれ `-` になる
        assert_eq!(encode_project_path("F:\\vive-editor"), "F--vive-editor");
        assert_eq!(
            encode_project_path("C:\\Users\\yusei\\Downloads\\vibe-editor"),
            "C--Users-yusei-Downloads-vibe-editor"
        );
        // macOS: 先頭 `/` がそのまま `-` に
        assert_eq!(
            encode_project_path("/Users/yusei/repo"),
            "-Users-yusei-repo"
        );
        // Linux: 先頭 `/` も `-` に。区切りはすべて `-`
        assert_eq!(
            encode_project_path("/home/yusei/projects/vibe"),
            "-home-yusei-projects-vibe"
        );
        // WSL UNC (`\\wsl.localhost\\Ubuntu\\home\\yusei`): `\` が連続して `--` になる
        assert_eq!(
            encode_project_path("\\\\wsl.localhost\\Ubuntu\\home\\yusei"),
            "--wsl-localhost-Ubuntu-home-yusei"
        );
        // 末尾 slash も `-` (encode 関数は trim しない: 上位で normalize する)
        assert_eq!(encode_project_path("/tmp/repo/"), "-tmp-repo-");
        // 大小区別は保持される (`F` と `f` を別 encoded ディレクトリにする)
        assert_ne!(encode_project_path("F:\\repo"), encode_project_path("f:\\repo"));
    }

    #[test]
    fn encode_project_path_is_pure_ascii_alnum_passthrough() {
        // ASCII 英数字はそのまま、それ以外 (`.` `-` `_` も含む) はすべて `-` になる挙動を固定。
        // claude_watcher.rs の jsonl ディレクトリ計算がこの規則を前提にしている。
        assert_eq!(encode_project_path("abc123"), "abc123");
        assert_eq!(encode_project_path("a.b_c-d"), "a-b-c-d");
        assert_eq!(encode_project_path("日本語"), "---");
    }
}

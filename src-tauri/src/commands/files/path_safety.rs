// commands/files/path_safety.rs
//
// files.rs から move された path safety 関連の helper (Phase 4-1 / Issue #373)。
// 相対パスを root 配下に閉じ込め、symlink 先が外部を指すケースも拒否する。

use std::path::{Component, Path, PathBuf};

/// 相対パスを root 配下に閉じ込める形で解決する。
///
/// 旧実装は `joined.canonicalize()` が失敗 (= 未作成ファイル) したとき `joined` をそのまま
/// `starts_with(&root)` に渡していたが、`Path::starts_with` はコンポーネント単位比較なので
/// `root/../outside.txt` のようなパスでも一致しすり抜ける (Issue #20)。
///
/// 正しい方針:
///   1. `rel` に絶対パス (Windows の `C:` prefix や POSIX の `/`) が含まれていたら拒否
///   2. コンポーネントを `.` / `..` / 通常成分に分解し、`..` が stack を空にする前に現れたら拒否
///      (root を脱出する `..`)
///   3. その上で物理 canonicalize を試み、symlink 解決後も root 配下であることを再確認
///
/// Issue #101: 未作成パスのとき、旧実装は「直接の親」しか canonicalize しなかったため、
/// `link/new-dir/file.txt` (link は外部を指す symlink/junction) のような「symlink 配下に
/// 多段ネストした未作成パス」で親 (`link/new-dir`) が canonicalize 失敗 → raw path の
/// starts_with だけで素通りしていた。本実装では「存在する最深祖先」まで遡って canonicalize し、
/// 祖先解決後のパスが root 配下かどうかで判定する。
pub fn safe_join(root: &str, rel: &str) -> Option<PathBuf> {
    let root = Path::new(root).canonicalize().ok()?;
    let rel_path = Path::new(rel);

    // (1) 絶対パス混入を拒否
    if rel_path.is_absolute() {
        return None;
    }

    // (2) コンポーネント単位で仮想的に正規化 (fs 非依存)
    let mut stack: Vec<&std::ffi::OsStr> = Vec::new();
    for comp in rel_path.components() {
        match comp {
            Component::Normal(name) => stack.push(name),
            Component::CurDir => { /* "." は無視 */ }
            Component::ParentDir => {
                // root 直下で ".." が来たら脱出なので拒否
                stack.pop()?;
            }
            // RootDir / Prefix / ... は絶対パス要素 → 既に (1) で弾いているが念のため拒否
            _ => return None,
        }
    }

    // 正規化後の joined パス (fs 実体は未作成かもしれない)
    let mut joined = root.clone();
    for c in &stack {
        joined.push(c);
    }

    // (3) 可能なら symlink 展開後も root 配下であることを再確認
    if let Ok(canonical) = joined.canonicalize() {
        if canonical.starts_with(&root) {
            return Some(canonical);
        }
        return None;
    }

    // (4) 未作成パス: 存在する最深祖先を canonicalize し、その祖先が root 配下なら
    //     祖先 canonical + (祖先より深い未作成成分) を返す。
    //     symlink/junction が途中に挟まっていても、ここで実体パスへ展開されるため
    //     未作成パス経由の脱出を確実に弾ける。
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut probe = joined.clone();
    loop {
        match probe.canonicalize() {
            Ok(canonical) => {
                if !canonical.starts_with(&root) {
                    return None;
                }
                let mut result = canonical;
                for name in tail.iter().rev() {
                    result.push(name);
                }
                return Some(result);
            }
            Err(_) => {
                let name = probe.file_name().map(|n| n.to_os_string());
                let parent = probe.parent().map(|p| p.to_path_buf());
                match (name, parent) {
                    (Some(n), Some(p)) if !p.as_os_str().is_empty() => {
                        tail.push(n);
                        probe = p;
                    }
                    // どこまで遡っても canonicalize できない (root 自体も canonicalize 失敗)
                    _ => return None,
                }
            }
        }
    }
}

#[cfg(test)]
mod safe_join_tests {
    use super::*;
    use std::fs;

    fn tempdir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("vibe-safe-join-{}", std::process::id()));
        let _ = fs::create_dir_all(&d);
        d.canonicalize().unwrap()
    }

    #[test]
    fn rejects_parent_escape() {
        let root = tempdir();
        let root_str = root.to_string_lossy();
        assert!(safe_join(&root_str, "../outside.txt").is_none());
        assert!(safe_join(&root_str, "a/../../outside.txt").is_none());
    }

    #[test]
    fn rejects_absolute() {
        let root = tempdir();
        let root_str = root.to_string_lossy();
        if cfg!(windows) {
            assert!(safe_join(&root_str, "C:\\Windows\\notepad.exe").is_none());
        } else {
            assert!(safe_join(&root_str, "/etc/passwd").is_none());
        }
    }

    #[test]
    fn allows_inside() {
        let root = tempdir();
        let root_str = root.to_string_lossy();
        assert!(safe_join(&root_str, "sub/file.txt").is_some());
        assert!(safe_join(&root_str, "a/../b.txt").is_some()); // 中間の .. は OK
        assert!(safe_join(&root_str, "./nested/./file.txt").is_some());
    }

    /// Issue #101: symlink 配下にある「未作成」のネストパスが、symlink 先 (= 外部)
    /// を解決できないことを利用して safe_join を素通りしないことを確認する。
    #[cfg(unix)]
    #[test]
    fn rejects_uncreated_path_under_symlink_to_outside() {
        use std::os::unix::fs::symlink as unix_symlink;

        let root = std::env::temp_dir().join(format!(
            "vibe-safe-join-symlink-{}",
            std::process::id()
        ));
        let outside = std::env::temp_dir().join(format!(
            "vibe-safe-join-outside-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();

        // root 配下に外部を指す symlink を作る
        let link = root.join("link");
        unix_symlink(&outside, &link).unwrap();

        let root_str = root.canonicalize().unwrap().to_string_lossy().into_owned();

        // link は外部を指すので link/new-dir/file.txt は拒否されるべき
        assert!(safe_join(&root_str, "link/new-dir/file.txt").is_none());
        // link 自体も外部解決されるので拒否
        assert!(safe_join(&root_str, "link/file.txt").is_none());

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    /// 多段ネストの未作成パスが root 配下なら通ること (Issue #101 修正の non-regression)。
    #[test]
    fn allows_uncreated_nested_path_inside_root() {
        let root = tempdir();
        let root_str = root.to_string_lossy();
        // root 配下に未作成のディレクトリ階層を含むパス
        assert!(safe_join(&root_str, "a/b/c/file.txt").is_some());
    }
}

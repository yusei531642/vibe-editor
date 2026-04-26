// files.* command — 旧 src/main/ipc/files.ts に対応
//
// 通常の fs 操作。tokio::fs を使い、エラーを ok=false で返す既存契約を維持。

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileListResult {
    pub ok: bool,
    pub error: Option<String>,
    pub dir: String,
    pub entries: Vec<FileNode>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileReadResult {
    pub ok: bool,
    pub error: Option<String>,
    pub path: String,
    pub content: String,
    pub is_binary: bool,
    pub encoding: String,
    /// Issue #65: open 時の mtime (ms since epoch)。save で外部変更検出に使う。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtime_ms: Option<u64>,
    /// Issue #104: open 時のファイルサイズ (bytes)。save で size mismatch も併用検出する。
    /// FS の mtime 解像度 (1 秒単位など) では 1 秒以内の変更を取り逃すため、size を併用する。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    /// Issue #119: open 時のファイル内容の SHA-256 (hex)。
    /// FS が秒精度しか持たず、かつ同サイズで上書きされた場合は mtime / size の両方で
    /// 検出を取りこぼすので、内容ハッシュを併用して conflict を見落とさないようにする。
    /// クライアントは write 時にこの値を `expected_content_hash` で送り返す。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileWriteResult {
    pub ok: bool,
    pub error: Option<String>,
    /// Issue #65: 書き込み後の mtime。次回 save 時の比較基準になる。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtime_ms: Option<u64>,
    /// Issue #104: 書き込み後のファイルサイズ。次回 save の比較基準になる。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    /// Issue #119: 書き込み後のファイル内容の SHA-256 (hex)。次回 save の比較基準。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
    /// Issue #65: 期待する mtime と現状が食い違った場合に true を返す。
    /// ok=false + conflict=true でフロントはユーザーに確認ダイアログを出す。
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub conflict: bool,
}

/// Issue #119: バイト列の SHA-256 を 16 進文字列で返す。
fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    let digest = h.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest.iter() {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

fn mtime_ms_of(meta: &std::fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
}

/// Issue #102: read 時に検出した encoding で content を再エンコードする。
/// "lossy" / "binary" は保存禁止。空 / "utf-8" は無印 UTF-8。
fn encode_for_save(content: &str, encoding: &str) -> Result<Vec<u8>, String> {
    match encoding {
        "" | "utf-8" => Ok(content.as_bytes().to_vec()),
        "utf-8-bom" => {
            let mut out = Vec::with_capacity(content.len() + 3);
            out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
            out.extend_from_slice(content.as_bytes());
            Ok(out)
        }
        "utf-16le" => {
            let mut out = Vec::with_capacity(content.len() * 2 + 2);
            out.extend_from_slice(&[0xFF, 0xFE]);
            for u in content.encode_utf16() {
                out.extend_from_slice(&u.to_le_bytes());
            }
            Ok(out)
        }
        "utf-16be" => {
            let mut out = Vec::with_capacity(content.len() * 2 + 2);
            out.extend_from_slice(&[0xFE, 0xFF]);
            for u in content.encode_utf16() {
                out.extend_from_slice(&u.to_be_bytes());
            }
            Ok(out)
        }
        "utf-32le" => {
            let mut out = Vec::with_capacity(content.len() * 4 + 4);
            out.extend_from_slice(&[0xFF, 0xFE, 0x00, 0x00]);
            for c in content.chars() {
                out.extend_from_slice(&(c as u32).to_le_bytes());
            }
            Ok(out)
        }
        "utf-32be" => {
            let mut out = Vec::with_capacity(content.len() * 4 + 4);
            out.extend_from_slice(&[0x00, 0x00, 0xFE, 0xFF]);
            for c in content.chars() {
                out.extend_from_slice(&(c as u32).to_be_bytes());
            }
            Ok(out)
        }
        // Issue #120: CP932 / Shift_JIS の round-trip 保存。
        // encoding_rs の SHIFT_JIS encoder は CP932 互換 (Windows の機種依存文字も扱える)。
        // unmappable がある場合は HTML 数値参照になるが、それは文字情報を失わずに残せるため
        // 「lossy 拒否」よりも実用的。
        "shift_jis" | "shift-jis" | "sjis" | "cp932" | "windows-31j" => {
            let (cow, _enc, had_unmappable) = encoding_rs::SHIFT_JIS.encode(content);
            // had_unmappable は HTML 数値参照に置換されていることを意味する。それでも書き込みは続行する
            // (元 encoding を維持したい意図のほうが強いケースが多いため)。
            let _ = had_unmappable;
            Ok(cow.into_owned())
        }
        "lossy" => Err(
            "cannot save: file was decoded with replacement characters (original encoding lost)"
                .into(),
        ),
        "binary" => Err("cannot save binary file".into()),
        other => Err(format!("unsupported encoding: {other}")),
    }
}

/// Issue #45: UTF-16 / UTF-32 / CP932 等も「テキスト」として扱えるよう拡張した判定。
/// 戻り値: (is_binary, content, encoding)
fn detect_text_or_binary(bytes: &[u8]) -> (bool, String, String) {
    // --- BOM による UTF-16/32 判定 ---
    if bytes.starts_with(&[0xFF, 0xFE, 0x00, 0x00]) {
        // UTF-32 LE BOM (UTF-16 LE と prefix 被るので先にチェック)
        return utf32_decode(&bytes[4..], true)
            .map(|s| (false, s, "utf-32le".to_string()))
            .unwrap_or((true, String::new(), "binary".to_string()));
    }
    if bytes.starts_with(&[0x00, 0x00, 0xFE, 0xFF]) {
        return utf32_decode(&bytes[4..], false)
            .map(|s| (false, s, "utf-32be".to_string()))
            .unwrap_or((true, String::new(), "binary".to_string()));
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return utf16_decode(&bytes[2..], true)
            .map(|s| (false, s, "utf-16le".to_string()))
            .unwrap_or((true, String::new(), "binary".to_string()));
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return utf16_decode(&bytes[2..], false)
            .map(|s| (false, s, "utf-16be".to_string()))
            .unwrap_or((true, String::new(), "binary".to_string()));
    }
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        // UTF-8 BOM
        let body = &bytes[3..];
        return match std::str::from_utf8(body) {
            // Issue #102: BOM 付きを保存時にも保持できるよう、明示的に "utf-8-bom" を返す。
            Ok(s) => (false, s.to_string(), "utf-8-bom".to_string()),
            Err(_) => (
                false,
                String::from_utf8_lossy(body).into_owned(),
                "lossy".to_string(),
            ),
        };
    }

    // --- BOM なし: 非テキスト control char の割合で判定 ---
    // 先頭 8KB をサンプリング
    let sample = &bytes[..bytes.len().min(8192)];
    let non_text = sample
        .iter()
        .filter(|&&b| {
            b == 0x00
                || (b < 0x09)
                || b == 0x0B
                || b == 0x0C
                || (b >= 0x0E && b < 0x20 && b != 0x1B) // ESC (0x1B) は xterm 系で許容
        })
        .count();
    // 非テキスト率が 30% を超えるなら binary とみなす
    if sample.len() > 0 && non_text * 100 / sample.len() >= 30 {
        return (true, String::new(), "binary".to_string());
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => (false, s.to_string(), "utf-8".to_string()),
        Err(_) => {
            // Issue #120: UTF-8 として無効なら CP932 (Shift_JIS) として復号を試みる。
            // encoding_rs の Shift_JIS は CP932 互換で、Windows の機種依存文字も含む。
            // had_errors=false なら全バイトが妥当な CP932 シーケンスとして解釈できたので
            // テキスト扱いし、save 時も同じ encoding で書き戻して round-trip を成立させる。
            let (cow, _enc, had_errors) = encoding_rs::SHIFT_JIS.decode(bytes);
            if !had_errors {
                (false, cow.into_owned(), "shift_jis".to_string())
            } else {
                // 最後の砦: UTF-8 lossy で読む。保存は拒否される (元 encoding 不明)。
                (
                    false,
                    String::from_utf8_lossy(bytes).into_owned(),
                    "lossy".to_string(),
                )
            }
        }
    }
}

fn utf16_decode(bytes: &[u8], little_endian: bool) -> Option<String> {
    if bytes.len() % 2 != 0 {
        return None;
    }
    let mut units = Vec::with_capacity(bytes.len() / 2);
    for chunk in bytes.chunks_exact(2) {
        let u = if little_endian {
            u16::from_le_bytes([chunk[0], chunk[1]])
        } else {
            u16::from_be_bytes([chunk[0], chunk[1]])
        };
        units.push(u);
    }
    String::from_utf16(&units).ok()
}

fn utf32_decode(bytes: &[u8], little_endian: bool) -> Option<String> {
    if bytes.len() % 4 != 0 {
        return None;
    }
    let mut out = String::with_capacity(bytes.len() / 4);
    for chunk in bytes.chunks_exact(4) {
        let u = if little_endian {
            u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])
        } else {
            u32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])
        };
        match char::from_u32(u) {
            Some(c) => out.push(c),
            None => return None,
        }
    }
    Some(out)
}

#[cfg(test)]
mod detect_tests {
    use super::detect_text_or_binary;

    #[test]
    fn utf8_ascii_is_text() {
        let (bin, _, enc) = detect_text_or_binary(b"hello world");
        assert!(!bin);
        assert_eq!(enc, "utf-8");
    }

    #[test]
    fn utf16_le_with_bom_is_text() {
        // "hi" in UTF-16 LE with BOM
        let bytes = [0xFF, 0xFE, b'h', 0x00, b'i', 0x00];
        let (bin, content, enc) = detect_text_or_binary(&bytes);
        assert!(!bin);
        assert_eq!(content, "hi");
        assert_eq!(enc, "utf-16le");
    }

    #[test]
    fn pure_binary_is_binary() {
        // mostly control bytes
        let bytes: Vec<u8> = (0u8..40).collect();
        let (bin, _, enc) = detect_text_or_binary(&bytes);
        assert!(bin);
        assert_eq!(enc, "binary");
    }

    #[test]
    fn utf8_bom_is_distinguished() {
        // Issue #102: BOM 付き UTF-8 は "utf-8-bom" を返し、保存時に BOM を保てる
        let bytes = [0xEF, 0xBB, 0xBF, b'h', b'i'];
        let (bin, content, enc) = detect_text_or_binary(&bytes);
        assert!(!bin);
        assert_eq!(content, "hi");
        assert_eq!(enc, "utf-8-bom");
    }
}

#[cfg(test)]
mod encode_tests {
    use super::encode_for_save;

    #[test]
    fn utf8_no_encoding_is_raw_bytes() {
        let out = encode_for_save("hello", "").unwrap();
        assert_eq!(out, b"hello");
    }

    #[test]
    fn utf8_bom_round_trips() {
        let out = encode_for_save("hi", "utf-8-bom").unwrap();
        assert_eq!(&out[..3], &[0xEF, 0xBB, 0xBF]);
        assert_eq!(&out[3..], b"hi");
    }

    #[test]
    fn utf16_le_round_trips() {
        let out = encode_for_save("hi", "utf-16le").unwrap();
        assert_eq!(out, [0xFF, 0xFE, b'h', 0x00, b'i', 0x00]);
    }

    #[test]
    fn utf16_be_round_trips() {
        let out = encode_for_save("hi", "utf-16be").unwrap();
        assert_eq!(out, [0xFE, 0xFF, 0x00, b'h', 0x00, b'i']);
    }

    #[test]
    fn lossy_is_rejected() {
        // Issue #102: lossy decode したファイルを保存すると元 encoding を失うため拒否
        assert!(encode_for_save("x", "lossy").is_err());
    }

    #[test]
    fn binary_is_rejected() {
        assert!(encode_for_save("x", "binary").is_err());
    }
}

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
                if stack.pop().is_none() {
                    return None;
                }
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

#[tauri::command]
pub async fn files_list(project_root: String, rel_path: String) -> FileListResult {
    let dir = safe_join(&project_root, &rel_path);
    let dir = match dir {
        Some(p) if p.is_dir() => p,
        _ => {
            return FileListResult {
                ok: false,
                error: Some("invalid path".into()),
                dir: rel_path,
                entries: vec![],
            }
        }
    };
    let mut entries = vec![];
    let mut rd = match tokio::fs::read_dir(&dir).await {
        Ok(r) => r,
        Err(e) => {
            return FileListResult {
                ok: false,
                error: Some(e.to_string()),
                dir: rel_path,
                entries: vec![],
            }
        }
    };
    // Issue #34: entry.path() は canonicalize された実パスを返すので、relative を取る
    // prefix は raw の project_root ではなく同じく canonicalize された root を使う必要がある。
    // Windows の junction / symlink / 大文字小文字違いで raw と real が食い違うと strip_prefix
    // が失敗して entry.path が空文字に落ちる。
    let canonical_root = Path::new(&project_root).canonicalize().ok();
    let root_ref = canonical_root.as_deref().unwrap_or_else(|| Path::new(&project_root));
    while let Ok(Some(entry)) = rd.next_entry().await {
        let p = entry.path();
        let is_dir = p.is_dir();
        let name = entry.file_name().to_string_lossy().into_owned();
        let rel = p
            .strip_prefix(root_ref)
            .map(|r| r.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        entries.push(FileNode {
            name,
            path: rel,
            is_dir,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    FileListResult {
        ok: true,
        error: None,
        dir: rel_path,
        entries,
    }
}

#[tauri::command]
pub async fn files_read(project_root: String, rel_path: String) -> FileReadResult {
    const MAX_READ_BYTES: u64 = 50 * 1024 * 1024;
    let abs = match safe_join(&project_root, &rel_path) {
        Some(p) => p,
        None => {
            return FileReadResult {
                ok: false,
                error: Some("invalid path".into()),
                path: rel_path,
                ..Default::default()
            }
        }
    };
    let meta = match tokio::fs::metadata(&abs).await {
        Ok(m) => m,
        Err(e) => {
            return FileReadResult {
                ok: false,
                error: Some(e.to_string()),
                path: rel_path,
                ..Default::default()
            }
        }
    };
    if meta.len() > MAX_READ_BYTES {
        return FileReadResult {
            ok: false,
            error: Some(format!(
                "file too large to open safely ({} bytes > {} bytes limit)",
                meta.len(),
                MAX_READ_BYTES
            )),
            path: rel_path,
            ..Default::default()
        };
    }
    let bytes = match tokio::fs::read(&abs).await {
        Ok(b) => b,
        Err(e) => {
            return FileReadResult {
                ok: false,
                error: Some(e.to_string()),
                path: rel_path,
                ..Default::default()
            }
        }
    };
    // Issue #45: 単純に NUL を含む = バイナリにすると UTF-16 / UTF-32 テキストが開けない。
    //   - UTF-16/32 は BOM (0xFF 0xFE, 0xFE 0xFF, 0x00 0x00 0xFE 0xFF 等) を持つので BOM 検出を優先
    //   - それ以外は「非テキスト char の割合」で判定: NUL の他に 0x01..0x08/0x0B/0x0E..0x1F を含む
    //     バイト比率が高いときだけバイナリ扱い。偽陽性を減らす。
    let (is_binary, content, encoding) = detect_text_or_binary(&bytes);
    // Issue #65 / #104: 開いた時点の mtime と size を返して、save 時の external-change 検出に使う
    // Issue #119: 加えて内容の SHA-256 を返す。FS が秒精度しか無く、かつ同サイズで書き換えられた
    // 場合に mtime/size 両方で見逃しても、内容ハッシュの不一致で conflict を確定できる。
    let mtime_ms = mtime_ms_of(&meta);
    let size_bytes = Some(meta.len());
    let content_hash = if !is_binary { Some(sha256_hex(&bytes)) } else { None };
    FileReadResult {
        ok: true,
        error: None,
        path: rel_path,
        content,
        is_binary,
        encoding,
        mtime_ms,
        size_bytes,
        content_hash,
    }
}

#[tauri::command]
pub async fn files_write(
    project_root: String,
    rel_path: String,
    content: String,
    // Issue #65: 前回 read 時の mtime_ms。指定時は save 直前に現在 mtime と比較して
    // 食い違いを検出する。未指定 (None) なら後方互換で検出をスキップ。
    expected_mtime_ms: Option<u64>,
    // Issue #104: 前回 read 時の size。mtime 解像度の粗い FS や 1 秒以内の連続変更の
    // 取りこぼし対策として併用する。
    expected_size_bytes: Option<u64>,
    // Issue #102: read 時の encoding。指定時はその encoding で再エンコードして書き戻す。
    // 未指定なら従来通り UTF-8。
    encoding: Option<String>,
    // Issue #119: 前回 read 時の SHA-256 (hex)。指定時は save 直前に現在ファイルの hash と比較し、
    // mtime/size を見逃した「同サイズ・1 秒以内」変更でも conflict を確定する。
    expected_content_hash: Option<String>,
) -> FileWriteResult {
    let abs = match safe_join(&project_root, &rel_path) {
        Some(p) => p,
        None => {
            return FileWriteResult {
                ok: false,
                error: Some("invalid path".into()),
                ..Default::default()
            }
        }
    };

    // Issue #102: 指定 encoding で再エンコード。lossy / binary は拒否。
    let encoding_str = encoding.as_deref().unwrap_or("");
    let bytes = match encode_for_save(&content, encoding_str) {
        Ok(b) => b,
        Err(e) => {
            return FileWriteResult {
                ok: false,
                error: Some(e),
                ..Default::default()
            }
        }
    };

    // Issue #65 / #104: 既存ファイルがある場合のみ external-change 検出
    if let Ok(meta) = tokio::fs::metadata(&abs).await {
        // Issue #104: mtime 比較は abs_diff で前後どちらのズレも検出する。
        // saturating_sub だと expected > current (時刻巻き戻り / 別 mtime のファイルへ
        // 差し替え) の場合に diff=0 で素通しされていた。
        if let Some(expected) = expected_mtime_ms {
            if let Some(current) = mtime_ms_of(&meta) {
                // 1 秒未満の誤差は無視 (一部 FS は秒精度しか持たないため)
                if current.abs_diff(expected) > 1000 {
                    return FileWriteResult {
                        ok: false,
                        error: Some("file changed on disk since it was opened".into()),
                        mtime_ms: Some(current),
                        size_bytes: Some(meta.len()),
                        conflict: true,
                        ..Default::default()
                    };
                }
            }
        }
        // Issue #104: size mismatch も conflict 扱い (mtime 解像度の補完)
        if let Some(expected_size) = expected_size_bytes {
            if meta.len() != expected_size {
                return FileWriteResult {
                    ok: false,
                    error: Some("file size changed on disk since it was opened".into()),
                    mtime_ms: mtime_ms_of(&meta),
                    size_bytes: Some(meta.len()),
                    conflict: true,
                    ..Default::default()
                };
            }
        }
        // Issue #119: 同サイズかつ 1 秒以内の編集は mtime/size 両方で見逃すため、
        // 期待ハッシュが渡ってきていれば現在ファイル内容とハッシュ比較する。
        if let Some(expected_hash) = expected_content_hash.as_deref() {
            if let Ok(current_bytes) = tokio::fs::read(&abs).await {
                let current_hash = sha256_hex(&current_bytes);
                if current_hash != expected_hash {
                    return FileWriteResult {
                        ok: false,
                        error: Some("file content changed on disk since it was opened".into()),
                        mtime_ms: mtime_ms_of(&meta),
                        size_bytes: Some(meta.len()),
                        content_hash: Some(current_hash),
                        conflict: true,
                    };
                }
            }
        }
    }

    if let Some(parent) = abs.parent() {
        if let Err(e) = tokio::fs::create_dir_all(parent).await {
            return FileWriteResult {
                ok: false,
                error: Some(e.to_string()),
                ..Default::default()
            };
        }
    }

    // Issue #103: 直接 fs::write だとクラッシュ時に半端書きが残る。atomic_write で
    // 同一ディレクトリ temp → fsync → rename 経由に置き換える。
    // symlink の場合は rename が symlink 自体を置き換えてしまうため、target を解決して
    // 実体パスに書き込む。
    let target_path = match tokio::fs::symlink_metadata(&abs).await {
        Ok(m) if m.file_type().is_symlink() => {
            // symlink を辿って実体を解決する。失敗時は元の path にフォールバック。
            tokio::fs::canonicalize(&abs).await.unwrap_or_else(|_| abs.clone())
        }
        _ => abs.clone(),
    };

    if let Err(e) = crate::commands::atomic_write::atomic_write(&target_path, &bytes).await {
        return FileWriteResult {
            ok: false,
            error: Some(e.to_string()),
            ..Default::default()
        };
    }

    let new_meta = tokio::fs::metadata(&target_path).await.ok();
    let mtime_ms = new_meta.as_ref().and_then(mtime_ms_of);
    let size_bytes = new_meta.as_ref().map(|m| m.len());
    // Issue #119: 書き込み後の hash も返す。次回 save の比較基準に使う。
    let content_hash = Some(sha256_hex(&bytes));
    FileWriteResult {
        ok: true,
        error: None,
        mtime_ms,
        size_bytes,
        content_hash,
        conflict: false,
    }
}

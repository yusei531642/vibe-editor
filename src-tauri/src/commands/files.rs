// files.* command — 旧 src/main/ipc/files.ts に対応
//
// 通常の fs 操作。tokio::fs を使い、エラーを ok=false で返す既存契約を維持。

mod encoding;
// Issue #642: `commands::team_history` から fingerprint 計算 (mtime + sha256) で再利用するため
// crate 内に公開する。`sha256_hex` / `mtime_ms_of` の 2 関数だけが対象。
pub(crate) mod hash;
mod path_safety;

use serde::Serialize;
use std::path::{Path, PathBuf};

use encoding::{detect_text_or_binary, encode_for_save};
use hash::{mtime_ms_of, sha256_hex};
// safe_join は外部 (commands/git.rs) からも呼ばれるので pub use で再 export する。
pub use path_safety::safe_join;

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
    let root_ref = canonical_root
        .as_deref()
        .unwrap_or_else(|| Path::new(&project_root));
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
    let Some(abs) = safe_join(&project_root, &rel_path) else {
        return FileReadResult {
            ok: false,
            error: Some("invalid path".into()),
            path: rel_path,
            ..Default::default()
        };
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
    let content_hash = if !is_binary {
        Some(sha256_hex(&bytes))
    } else {
        None
    };
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
    let Some(abs) = safe_join(&project_root, &rel_path) else {
        return FileWriteResult {
            ok: false,
            error: Some("invalid path".into()),
            ..Default::default()
        };
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
            tokio::fs::canonicalize(&abs)
                .await
                .unwrap_or_else(|_| abs.clone())
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

// ---------------------------------------------------------------------------
// Issue #592: ファイルツリー右クリックメニュー (VS Code 互換) 用の追加 IPC
//
// 提供コマンド:
//   - files_create:     新規ファイル作成 (空)
//   - files_create_dir: 新規ディレクトリ作成
//   - files_rename:     ファイル/ディレクトリのリネーム or 同一ルート内移動
//   - files_delete:     ファイル/ディレクトリ削除 (既定で OS のゴミ箱、`permanent=true` で完全削除)
//   - files_copy:       ファイル/ディレクトリの再帰コピー (cut/copy & paste の copy 経路)
//
// 設計方針:
//   - 入力の rel_path はすべて `safe_join` でルート内に閉じ込める (TOCTOU 含む脱出を防ぐ)
//   - 名前 1 セグメント (basename) には別途 `validate_basename` を通し、
//     `..` / 区切り文字 / NUL / control char / Windows の予約名を弾く
//   - 既存ファイルの上書きはデフォルト拒否 (`overwrite=false`)。明示的に true を渡したときだけ許可
//   - 戻り値は既存の `ok/error` 契約を踏襲した struct で、frontend は `res.ok` だけ見れば良い
// ---------------------------------------------------------------------------

/// ファイル/ディレクトリ操作の汎用結果。`ok=false` なら `error` に人間可読の理由が入る。
/// `path` は操作対象 (作成・削除・rename の to/copy の to) の相対パスを返すことで、
/// frontend 側で再 list 不要なケースのキャッシュ更新に使える。
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileMutationResult {
    pub ok: bool,
    pub error: Option<String>,
    pub path: String,
}

impl FileMutationResult {
    fn err(path: impl Into<String>, msg: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(msg.into()),
            path: path.into(),
        }
    }
    fn success(path: impl Into<String>) -> Self {
        Self {
            ok: true,
            error: None,
            path: path.into(),
        }
    }
}

/// 1 セグメントの basename が安全かどうかを検証する。
///
/// - 空文字 / `.` / `..` を拒否
/// - パス区切り (`/` `\\`) を含むものを拒否 (basename ではないため)
/// - NUL / 制御文字 (0x00..0x1F, 0x7F) を拒否
/// - Windows の禁止文字 (`<` `>` `:` `"` `|` `?` `*`) を拒否
/// - Windows の予約名 (CON / PRN / AUX / NUL / COM1-9 / LPT1-9) を拒否 (case insensitive)
/// - Windows で名前末尾の空白 / `.` を拒否 (FS 上で truncate される)
/// - 長さは 255 byte 以内 (大半の FS の上限に合わせる)
fn validate_basename(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("name is empty".into());
    }
    if name == "." || name == ".." {
        return Err("name '.' or '..' is not allowed".into());
    }
    if name.len() > 255 {
        return Err("name is too long (max 255 bytes)".into());
    }
    for ch in name.chars() {
        if ch == '/' || ch == '\\' {
            return Err("name contains path separator".into());
        }
        if ch == '\0' {
            return Err("name contains NUL".into());
        }
        if (ch as u32) < 0x20 || ch == '\u{7F}' {
            return Err("name contains control character".into());
        }
    }
    for bad in ['<', '>', ':', '"', '|', '?', '*'] {
        if name.contains(bad) {
            return Err(format!("name contains forbidden character '{bad}'"));
        }
    }
    let stem_upper = name
        .split_once('.')
        .map_or(name, |(stem, _)| stem)
        .to_uppercase();
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if RESERVED.iter().any(|r| *r == stem_upper) {
        return Err(format!("'{name}' is a reserved name on Windows"));
    }
    if name.ends_with(' ') || name.ends_with('.') {
        return Err("name cannot end with space or '.'".into());
    }
    Ok(())
}

/// 親ディレクトリ rel_path 配下に basename を足した絶対パスを `safe_join` で得る。
/// basename invalid もしくは safe_join 失敗 (= ルート脱出 / canonicalize 不能) で None。
fn join_child(project_root: &str, parent_rel: &str, name: &str) -> Option<PathBuf> {
    validate_basename(name).ok()?;
    let combined = if parent_rel.is_empty() {
        name.to_string()
    } else {
        format!("{}/{}", parent_rel.trim_end_matches('/'), name)
    };
    safe_join(project_root, &combined)
}

/// canonicalize 済みの project_root から見た相対パス (POSIX 区切り) を返す。
/// frontend のキャッシュキー (FileNode.path) と整合させるための helper。
fn rel_from_abs(project_root: &str, abs: &Path) -> String {
    let canonical_root = match Path::new(project_root).canonicalize() {
        Ok(p) => p,
        Err(_) => return abs.to_string_lossy().into_owned(),
    };
    abs.strip_prefix(&canonical_root)
        .map(|r| r.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default()
}

/// Issue #592: 新規ファイルを作成する。`rel_path` は親ディレクトリ (空文字でルート直下)。
/// `name` は basename。`overwrite=false` のとき既存ファイルがあれば失敗を返す。
#[tauri::command]
pub async fn files_create(
    project_root: String,
    rel_path: String,
    name: String,
    overwrite: Option<bool>,
) -> FileMutationResult {
    let overwrite = overwrite.unwrap_or(false);
    let parent_abs = match safe_join(&project_root, &rel_path) {
        Some(p) if p.is_dir() => p,
        Some(_) => return FileMutationResult::err(rel_path, "parent path is not a directory"),
        None => return FileMutationResult::err(rel_path, "invalid parent path"),
    };
    if let Err(e) = validate_basename(&name) {
        return FileMutationResult::err(rel_path, e);
    }
    let abs = match join_child(&project_root, &rel_path, &name) {
        Some(p) => p,
        None => return FileMutationResult::err(rel_path, "invalid target path"),
    };
    if abs.parent() != Some(parent_abs.as_path()) {
        return FileMutationResult::err(rel_path, "target path escapes parent directory");
    }
    if !overwrite && tokio::fs::metadata(&abs).await.is_ok() {
        return FileMutationResult::err(rel_from_abs(&project_root, &abs), "file already exists");
    }
    if let Err(e) = crate::commands::atomic_write::atomic_write(&abs, b"").await {
        return FileMutationResult::err(
            rel_from_abs(&project_root, &abs),
            format!("create failed: {e}"),
        );
    }
    FileMutationResult::success(rel_from_abs(&project_root, &abs))
}

/// Issue #592: 新規ディレクトリを作成する。親ディレクトリは存在している必要がある。
#[tauri::command]
pub async fn files_create_dir(
    project_root: String,
    rel_path: String,
    name: String,
) -> FileMutationResult {
    let parent_abs = match safe_join(&project_root, &rel_path) {
        Some(p) if p.is_dir() => p,
        Some(_) => return FileMutationResult::err(rel_path, "parent path is not a directory"),
        None => return FileMutationResult::err(rel_path, "invalid parent path"),
    };
    if let Err(e) = validate_basename(&name) {
        return FileMutationResult::err(rel_path, e);
    }
    let abs = match join_child(&project_root, &rel_path, &name) {
        Some(p) => p,
        None => return FileMutationResult::err(rel_path, "invalid target path"),
    };
    if abs.parent() != Some(parent_abs.as_path()) {
        return FileMutationResult::err(rel_path, "target path escapes parent directory");
    }
    if tokio::fs::metadata(&abs).await.is_ok() {
        return FileMutationResult::err(rel_from_abs(&project_root, &abs), "path already exists");
    }
    if let Err(e) = tokio::fs::create_dir(&abs).await {
        return FileMutationResult::err(
            rel_from_abs(&project_root, &abs),
            format!("create_dir failed: {e}"),
        );
    }
    FileMutationResult::success(rel_from_abs(&project_root, &abs))
}

/// Issue #592: ファイル/ディレクトリの rename or 同一ルート内移動。
/// `from_rel` 既存パス、`to_parent_rel` 親ディレクトリ、`new_name` basename。
/// 既存パス上書きは `overwrite=true` のときのみ許可。
#[tauri::command]
pub async fn files_rename(
    project_root: String,
    from_rel: String,
    to_parent_rel: String,
    new_name: String,
    overwrite: Option<bool>,
) -> FileMutationResult {
    let overwrite = overwrite.unwrap_or(false);
    let from_abs = match safe_join(&project_root, &from_rel) {
        Some(p) => p,
        None => return FileMutationResult::err(from_rel, "invalid source path"),
    };
    if tokio::fs::symlink_metadata(&from_abs).await.is_err() {
        return FileMutationResult::err(from_rel, "source does not exist");
    }
    if let Err(e) = validate_basename(&new_name) {
        return FileMutationResult::err(from_rel, e);
    }
    let parent_abs = match safe_join(&project_root, &to_parent_rel) {
        Some(p) if p.is_dir() => p,
        Some(_) => {
            return FileMutationResult::err(from_rel, "destination parent is not a directory")
        }
        None => return FileMutationResult::err(from_rel, "invalid destination parent"),
    };
    let to_abs = match join_child(&project_root, &to_parent_rel, &new_name) {
        Some(p) => p,
        None => return FileMutationResult::err(from_rel, "invalid destination path"),
    };
    if to_abs.parent() != Some(parent_abs.as_path()) {
        return FileMutationResult::err(from_rel, "destination escapes parent directory");
    }
    if from_abs == to_abs {
        return FileMutationResult::success(rel_from_abs(&project_root, &to_abs));
    }
    if to_abs.starts_with(&from_abs) {
        return FileMutationResult::err(
            from_rel,
            "cannot move a directory into itself or its descendant",
        );
    }
    if !overwrite && tokio::fs::metadata(&to_abs).await.is_ok() {
        return FileMutationResult::err(
            rel_from_abs(&project_root, &to_abs),
            "destination already exists",
        );
    }
    if let Err(e) = tokio::fs::rename(&from_abs, &to_abs).await {
        return FileMutationResult::err(
            rel_from_abs(&project_root, &to_abs),
            format!("rename failed: {e}"),
        );
    }
    FileMutationResult::success(rel_from_abs(&project_root, &to_abs))
}

/// Issue #592: ファイル/ディレクトリの削除。
/// `permanent=false` (default) は OS のゴミ箱に送り、`true` なら完全削除する。
#[tauri::command]
pub async fn files_delete(
    project_root: String,
    rel_path: String,
    permanent: Option<bool>,
) -> FileMutationResult {
    if rel_path.is_empty() {
        return FileMutationResult::err(rel_path, "cannot delete project root");
    }
    let abs = match safe_join(&project_root, &rel_path) {
        Some(p) => p,
        None => return FileMutationResult::err(rel_path, "invalid path"),
    };
    let meta = match tokio::fs::symlink_metadata(&abs).await {
        Ok(m) => m,
        Err(e) => return FileMutationResult::err(rel_path, format!("path not found: {e}")),
    };
    let is_dir = meta.is_dir();
    let permanent = permanent.unwrap_or(false);
    if !permanent {
        let abs_clone = abs.clone();
        match tokio::task::spawn_blocking(move || trash::delete(&abs_clone)).await {
            Ok(Ok(())) => return FileMutationResult::success(rel_path),
            Ok(Err(e)) => {
                return FileMutationResult::err(rel_path, format!("move to trash failed: {e}"));
            }
            Err(je) => {
                return FileMutationResult::err(rel_path, format!("trash task join failed: {je}"));
            }
        }
    }
    let res = if is_dir {
        tokio::fs::remove_dir_all(&abs).await
    } else {
        tokio::fs::remove_file(&abs).await
    };
    match res {
        Ok(()) => FileMutationResult::success(rel_path),
        Err(e) => FileMutationResult::err(rel_path, format!("delete failed: {e}")),
    }
}

/// Issue #592: ファイル/ディレクトリを再帰コピーする。
/// `from_rel` 既存パス、`to_parent_rel` コピー先親ディレクトリ、`new_name` 新しい basename。
#[tauri::command]
pub async fn files_copy(
    project_root: String,
    from_rel: String,
    to_parent_rel: String,
    new_name: String,
    overwrite: Option<bool>,
) -> FileMutationResult {
    let overwrite = overwrite.unwrap_or(false);
    let from_abs = match safe_join(&project_root, &from_rel) {
        Some(p) => p,
        None => return FileMutationResult::err(from_rel, "invalid source path"),
    };
    let from_meta = match tokio::fs::symlink_metadata(&from_abs).await {
        Ok(m) => m,
        Err(e) => return FileMutationResult::err(from_rel, format!("source not found: {e}")),
    };
    if let Err(e) = validate_basename(&new_name) {
        return FileMutationResult::err(from_rel, e);
    }
    let parent_abs = match safe_join(&project_root, &to_parent_rel) {
        Some(p) if p.is_dir() => p,
        Some(_) => {
            return FileMutationResult::err(from_rel, "destination parent is not a directory")
        }
        None => return FileMutationResult::err(from_rel, "invalid destination parent"),
    };
    let to_abs = match join_child(&project_root, &to_parent_rel, &new_name) {
        Some(p) => p,
        None => return FileMutationResult::err(from_rel, "invalid destination path"),
    };
    if to_abs.parent() != Some(parent_abs.as_path()) {
        return FileMutationResult::err(from_rel, "destination escapes parent directory");
    }
    if to_abs.starts_with(&from_abs) {
        return FileMutationResult::err(
            from_rel,
            "cannot copy into the source or its descendant",
        );
    }
    if !overwrite && tokio::fs::metadata(&to_abs).await.is_ok() {
        return FileMutationResult::err(
            rel_from_abs(&project_root, &to_abs),
            "destination already exists",
        );
    }
    let res = if from_meta.is_dir() {
        copy_dir_recursive(&from_abs, &to_abs).await
    } else {
        match tokio::fs::copy(&from_abs, &to_abs).await {
            Ok(_) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    };
    match res {
        Ok(()) => FileMutationResult::success(rel_from_abs(&project_root, &to_abs)),
        Err(e) => FileMutationResult::err(
            rel_from_abs(&project_root, &to_abs),
            format!("copy failed: {e}"),
        ),
    }
}

/// ディレクトリを再帰コピーする。symlink は follow せず、target は通常ファイルとしてコピーする。
async fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    if let Err(e) = tokio::fs::create_dir_all(dst).await {
        return Err(e.to_string());
    }
    let mut stack: Vec<(PathBuf, PathBuf)> = vec![(src.to_path_buf(), dst.to_path_buf())];
    while let Some((from, to)) = stack.pop() {
        let mut rd = tokio::fs::read_dir(&from)
            .await
            .map_err(|e| e.to_string())?;
        while let Some(entry) = rd.next_entry().await.map_err(|e| e.to_string())? {
            let from_child = entry.path();
            let name = match from_child.file_name() {
                Some(n) => n.to_os_string(),
                None => continue,
            };
            let to_child = to.join(&name);
            let meta = entry.metadata().await.map_err(|e| e.to_string())?;
            if meta.is_dir() {
                if let Err(e) = tokio::fs::create_dir_all(&to_child).await {
                    return Err(e.to_string());
                }
                stack.push((from_child, to_child));
            } else {
                tokio::fs::copy(&from_child, &to_child)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod issue_592_tests {
    use super::*;
    use tempfile::tempdir;

    fn root_str(td: &tempfile::TempDir) -> String {
        td.path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn validate_basename_rejects_bad_inputs() {
        assert!(validate_basename("").is_err());
        assert!(validate_basename(".").is_err());
        assert!(validate_basename("..").is_err());
        assert!(validate_basename("foo/bar").is_err());
        assert!(validate_basename("foo\\bar").is_err());
        assert!(validate_basename("foo\0bar").is_err());
        assert!(validate_basename("foo\x01bar").is_err());
        assert!(validate_basename("CON").is_err());
        assert!(validate_basename("con.txt").is_err());
        assert!(validate_basename("nul.log").is_err());
        assert!(validate_basename("foo ").is_err());
        assert!(validate_basename("foo.").is_err());
        assert!(validate_basename("foo<bar>").is_err());
    }

    #[test]
    fn validate_basename_accepts_normal() {
        assert!(validate_basename("foo.txt").is_ok());
        assert!(validate_basename("README.md").is_ok());
        assert!(validate_basename("日本語.rs").is_ok());
        assert!(validate_basename("a-b_c.1").is_ok());
    }

    #[tokio::test]
    async fn files_create_creates_file_in_root() {
        let td = tempdir().unwrap();
        let root = root_str(&td);
        let res = files_create(root.clone(), "".into(), "hello.txt".into(), None).await;
        assert!(res.ok, "{:?}", res.error);
        assert!(td.path().join("hello.txt").exists());
    }

    #[tokio::test]
    async fn files_create_rejects_path_traversal_via_name() {
        let td = tempdir().unwrap();
        let root = root_str(&td);
        let res = files_create(root, "".into(), "../escape.txt".into(), None).await;
        assert!(!res.ok);
    }

    #[tokio::test]
    async fn files_create_rejects_existing_without_overwrite() {
        let td = tempdir().unwrap();
        let root = root_str(&td);
        let r1 = files_create(root.clone(), "".into(), "x.txt".into(), None).await;
        assert!(r1.ok);
        let r2 = files_create(root.clone(), "".into(), "x.txt".into(), Some(false)).await;
        assert!(!r2.ok);
    }

    #[tokio::test]
    async fn files_create_dir_creates_subdir() {
        let td = tempdir().unwrap();
        let root = root_str(&td);
        let res = files_create_dir(root, "".into(), "subdir".into()).await;
        assert!(res.ok, "{:?}", res.error);
        assert!(td.path().join("subdir").is_dir());
    }

    #[tokio::test]
    async fn files_rename_moves_file() {
        let td = tempdir().unwrap();
        let root = root_str(&td);
        files_create(root.clone(), "".into(), "a.txt".into(), None).await;
        let res =
            files_rename(root.clone(), "a.txt".into(), "".into(), "b.txt".into(), None).await;
        assert!(res.ok, "{:?}", res.error);
        assert!(!td.path().join("a.txt").exists());
        assert!(td.path().join("b.txt").exists());
    }

    #[tokio::test]
    async fn files_rename_rejects_self_into_descendant() {
        let td = tempdir().unwrap();
        let root = root_str(&td);
        files_create_dir(root.clone(), "".into(), "dir1".into()).await;
        let res = files_rename(
            root.clone(),
            "dir1".into(),
            "dir1".into(),
            "nested".into(),
            None,
        )
        .await;
        assert!(!res.ok);
    }

    #[tokio::test]
    async fn files_copy_clones_file() {
        let td = tempdir().unwrap();
        let root = root_str(&td);
        files_create(root.clone(), "".into(), "a.txt".into(), None).await;
        std::fs::write(td.path().join("a.txt"), b"hi").unwrap();
        let res = files_copy(
            root.clone(),
            "a.txt".into(),
            "".into(),
            "a.copy.txt".into(),
            None,
        )
        .await;
        assert!(res.ok, "{:?}", res.error);
        assert_eq!(std::fs::read(td.path().join("a.copy.txt")).unwrap(), b"hi");
    }

    #[tokio::test]
    async fn files_copy_recurses_directory() {
        let td = tempdir().unwrap();
        let root = root_str(&td);
        files_create_dir(root.clone(), "".into(), "src".into()).await;
        std::fs::write(td.path().join("src").join("a.txt"), b"a").unwrap();
        std::fs::create_dir(td.path().join("src").join("nested")).unwrap();
        std::fs::write(td.path().join("src").join("nested").join("b.txt"), b"b").unwrap();
        let res = files_copy(root.clone(), "src".into(), "".into(), "dst".into(), None).await;
        assert!(res.ok, "{:?}", res.error);
        assert_eq!(std::fs::read(td.path().join("dst").join("a.txt")).unwrap(), b"a");
        assert_eq!(
            std::fs::read(td.path().join("dst").join("nested").join("b.txt")).unwrap(),
            b"b"
        );
    }

    #[tokio::test]
    async fn files_copy_rejects_into_descendant() {
        let td = tempdir().unwrap();
        let root = root_str(&td);
        files_create_dir(root.clone(), "".into(), "a".into()).await;
        let res = files_copy(root.clone(), "a".into(), "a".into(), "inside".into(), None).await;
        assert!(!res.ok);
    }

    #[tokio::test]
    async fn files_delete_permanent_removes_file() {
        let td = tempdir().unwrap();
        let root = root_str(&td);
        files_create(root.clone(), "".into(), "g.txt".into(), None).await;
        let res = files_delete(root.clone(), "g.txt".into(), Some(true)).await;
        assert!(res.ok, "{:?}", res.error);
        assert!(!td.path().join("g.txt").exists());
    }

    #[tokio::test]
    async fn files_delete_rejects_root() {
        let td = tempdir().unwrap();
        let root = root_str(&td);
        let res = files_delete(root, "".into(), Some(true)).await;
        assert!(!res.ok);
    }
}

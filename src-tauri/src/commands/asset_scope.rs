// Issue #724 (Security): `asset://` protocol scope の動的許可。
//
// 背景:
//   tauri.conf.json の `app.security.assetProtocol.scope` は以前 `**/*.png` などの拡張子
//   ワイルドカードだけで、ディレクトリ制約が無かった。これは `asset://localhost/<任意パス>`
//   で OS 上のあらゆる画像 / SVG が renderer から読める設定で、renderer XSS が 1 件でも
//   成立すると `~/Documents/private.png` 等が漏れる過大権限だった (監査 F-HIGH-3)。
//
//   修正として `assetProtocol.scope` を空配列にし (= 起動直後は asset protocol 経由で
//   何も読めない)、renderer が実際に画像を表示する必要のあるパスだけを、このモジュールの
//   ヘルパーで `asset_protocol_scope().allow_directory` / `allow_file` を使って実行時に
//   許可リストへ加える方針に切り替えた。
//
// 許可対象は 2 経路のみ:
//   1. project_root 配下 — 画像プレビュー (Issue #325: ImagePreview / EditorView) が
//      ファイルツリーから開いた画像。`app_set_project_root` から `allow_asset_dir` で
//      project_root を recursive 許可する。project_root 自体は `is_safe_watch_root`
//      (system / home 直下 reject) を通った正当なディレクトリだけ。
//   2. mascot custom 画像 (PR #716) — ユーザーがファイルダイアログで選んだ単一画像。
//      `allow_asset_file` で「そのファイル 1 個だけ」を許可する (ディレクトリごとは
//      許可しないので、同じフォルダの他の画像は漏れない)。
//
// I/O / ロックの失敗はすべて best-effort で warn ログのみに留める。asset scope への
// 追加に失敗しても画像が表示されないだけで、起動やファイル操作自体は壊さない。
//
// PR #775 (auto-review): mascot custom path は renderer 由来 (settings.json の
// `statusMascotCustomPath`) なので、renderer XSS が `/etc/passwd` のような任意パスを
// 注入して asset scope に追加させるバイパスを防ぐため、`is_allowed_mascot_path` で
// 「画像拡張子ホワイトリスト」+「parent ディレクトリの is_safe_watch_root 検証」を
// 通したものだけを `allow_asset_file` へ渡す。

use std::path::Path;
use tauri::{AppHandle, Manager};

/// mascot custom 画像として `asset://` 許可してよい拡張子のホワイトリスト。
/// 旧 `tauri.conf.json` の `assetProtocol.scope` が列挙していた画像形式と同一 (Issue #724)。
const ALLOWED_MASCOT_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg", "apng",
];

/// PR #775 (auto-review): renderer 由来の mascot custom path を `asset://` 許可リストへ
/// 加えてよいかを判定する。次の 2 条件を **両方** 満たすときのみ `true`:
///   1. 拡張子が画像ホワイトリスト (`ALLOWED_MASCOT_EXTENSIONS`) に含まれる
///      (case-insensitive)。`/etc/passwd` のような非画像ファイルを弾く。
///   2. その**親ディレクトリ**が `is_safe_watch_root` を通る (canonicalize 可能で
///      system 領域 / home 直下 / ルートドライブでない実ディレクトリ)。
///      `app_set_project_root` が project_root に課しているのと同じ judgement を
///      mascot の置き場所にも適用し、影響半径を「ユーザーが普通に画像を置く場所」に絞る。
///
/// `path` が拡張子を持たない / 親を取れない場合は `false`。
pub fn is_allowed_mascot_path(path: &Path) -> bool {
    let ext_ok = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| ALLOWED_MASCOT_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false);
    if !ext_ok {
        return false;
    }
    // 親ディレクトリを is_safe_watch_root で検証する。親が取れない (= ルート直下や
    // 相対パスの先頭要素) ケースは安全側に倒して reject する。
    match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => {
            crate::commands::fs_watch::is_safe_watch_root(parent)
        }
        _ => false,
    }
}

/// `dir` 配下 (サブディレクトリ含む) を `asset://` で読めるように許可リストへ加える。
///
/// 画像プレビュー (Issue #325) 用。`app_set_project_root` から project_root を渡して呼ぶ。
/// `dir` が空 / 非ディレクトリのときは何もしない。失敗は warn ログのみ。
pub fn allow_asset_dir(app: &AppHandle, dir: &Path) {
    if dir.as_os_str().is_empty() {
        return;
    }
    if !dir.is_dir() {
        tracing::debug!(
            "[asset-scope] skip allow_directory — not a directory: {}",
            dir.display()
        );
        return;
    }
    let scope = app.asset_protocol_scope();
    match scope.allow_directory(dir, true) {
        Ok(()) => tracing::info!("[asset-scope] allowed directory: {}", dir.display()),
        Err(e) => tracing::warn!(
            "[asset-scope] failed to allow directory {}: {e:#}",
            dir.display()
        ),
    }
}

/// `file` 1 個だけを `asset://` で読めるように許可リストへ加える。
///
/// mascot custom 画像 (PR #716) 用。ユーザーがファイルダイアログで選んだ画像のみを
/// ピンポイントで許可し、同じフォルダの他ファイルは許可しない (最小権限)。
/// `file` が空 / 非ファイルのときは何もしない。失敗は warn ログのみ。
pub fn allow_asset_file(app: &AppHandle, file: &Path) {
    if file.as_os_str().is_empty() {
        return;
    }
    if !file.is_file() {
        tracing::debug!(
            "[asset-scope] skip allow_file — not a file: {}",
            file.display()
        );
        return;
    }
    let scope = app.asset_protocol_scope();
    match scope.allow_file(file) {
        Ok(()) => tracing::info!("[asset-scope] allowed file: {}", file.display()),
        Err(e) => {
            tracing::warn!("[asset-scope] failed to allow file {}: {e:#}", file.display())
        }
    }
}

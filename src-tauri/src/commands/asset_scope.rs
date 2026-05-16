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

use std::path::Path;
use tauri::{AppHandle, Manager};

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

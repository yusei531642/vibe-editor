/**
 * Issue #67: recentProjects / workspaceFolders の比較用キーを生成する。
 *
 * 表示は raw path を残すが、重複判定は normalize 後のキーで行う:
 * - 区切りを `/` に統一
 * - 末尾の `/` を除去 (ただしルート `/` `C:/` は保持)
 * - Windows ドライブレター (`C:`) を小文字化
 *
 * Rust 側 `normalize_project_root` (src-tauri/src/pty/path_norm.rs) と同じ規則。
 */
export function normalizePathKey(raw: string): string {
  if (!raw) return '';
  let p = raw.replace(/\\/g, '/');
  // drive letter 小文字化
  if (/^[A-Za-z]:\//.test(p)) {
    p = p.charAt(0).toLowerCase() + p.slice(1);
  }
  // 連続 / を 1 個に、末尾 / を取り除く (ただしルートは残す)
  p = p.replace(/\/+/g, '/');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

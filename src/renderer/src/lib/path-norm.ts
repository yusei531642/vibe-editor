/**
 * path-norm.ts — Renderer 側の path 正規化。
 *
 * Issue #67 対応: recentProjects / workspaceFolders の dedup 比較で使う。
 * Rust 側 pty::path_norm::normalize_project_root と同じ戦略 (fallback 部分):
 *   - `\` → `/`
 *   - 末尾 `/` 削除
 *   - プラットフォームに応じて小文字化 (Windows 大文字小文字区別なしに合わせる)
 *
 * canonicalize は renderer で利用不可 (fs 依存) なので、raw 文字列レベルの正規化のみ行う。
 * 実体まで一致させたい場合は Rust 側の normalize_project_root を使う。
 */
export function normalizePath(raw: string): string {
  if (!raw) return '';
  const unified = raw.replace(/\\/g, '/');
  const trimmed = unified.replace(/\/+$/g, '');
  // Windows の path 比較は case-insensitive。navigator.platform で判別。
  const isWindows =
    typeof navigator !== 'undefined' &&
    /Win/i.test(navigator.platform ?? navigator.userAgent ?? '');
  return isWindows ? trimmed.toLowerCase() : trimmed;
}

/**
 * 既存リストから同じ path (normalize 後一致) を除外した上で、先頭に `path` を追加。
 * 返ってくる配列は最大 `limit` 件にトリムされる。
 */
export function dedupPrepend(list: string[], path: string, limit = 10): string[] {
  const key = normalizePath(path);
  const filtered = list.filter((p) => normalizePath(p) !== key);
  return [path, ...filtered].slice(0, limit);
}

/** `path` が既存リスト中 (normalize 比較) に存在するか */
export function listContainsPath(list: string[], path: string): boolean {
  const key = normalizePath(path);
  return list.some((p) => normalizePath(p) === key);
}

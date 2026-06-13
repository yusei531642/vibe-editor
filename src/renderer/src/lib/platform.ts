/**
 * Issue #981: レンダラー側で OS プラットフォームを判定する単一窓口。
 *
 * Tauri の WebView では `navigator.userAgent` / `navigator.platform` に OS 名が
 * 入る。従来は各所 (`path-norm` / `updater-check` / `use-window-frame-insets` 等)
 * で個別に正規表現判定していたため、ここに集約して表記揺れを防ぐ。
 *
 * SSR / 非ブラウザ環境を考慮し `navigator` 未定義でも落ちないようにする。
 */

const ua: string =
  typeof navigator !== 'undefined'
    ? `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`
    : '';

/** macOS (Tauri の userAgent は "Macintosh; ... Mac OS X" を含む) */
export const isMacOS: boolean = /Mac/i.test(ua);

/** Windows */
export const isWindows: boolean = /Win/i.test(ua);

/** Linux (Android を除く。vibe-editor は desktop のみ対象) */
export const isLinux: boolean = /Linux/i.test(ua) && !/Android/i.test(ua);

/** tokens.css / shell.css の `:root[data-platform='…']` と一致する識別子。 */
export function platformId(): 'macos' | 'windows' | 'linux' | 'other' {
  if (isWindows) return 'windows';
  if (isMacOS) return 'macos';
  if (isLinux) return 'linux';
  return 'other';
}

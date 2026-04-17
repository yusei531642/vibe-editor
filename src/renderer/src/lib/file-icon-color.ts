/**
 * ファイル名 (拡張子) からアイコンに与える色トークンを返す。
 * Windsurf / VSCode の Material Icon Theme を参考にした最小マッピング。
 * 値は CSS の色そのもの (var() を返さない) — index.css のテーマ変数に依存しない。
 */
const EXT_COLOR: Record<string, string> = {
  // TypeScript / JavaScript
  ts: '#3b82f6',
  tsx: '#3b82f6',
  mts: '#3b82f6',
  cts: '#3b82f6',
  js: '#eab308',
  jsx: '#eab308',
  mjs: '#eab308',
  cjs: '#eab308',
  // データ
  json: '#facc15',
  yaml: '#ef4444',
  yml: '#ef4444',
  toml: '#a16207',
  xml: '#fb923c',
  csv: '#10b981',
  // Web
  html: '#f97316',
  htm: '#f97316',
  css: '#ec4899',
  scss: '#ec4899',
  sass: '#ec4899',
  less: '#0ea5e9',
  // システム言語
  rs: '#f97316',
  go: '#06b6d4',
  py: '#22c55e',
  rb: '#ef4444',
  java: '#f97316',
  kt: '#a855f7',
  swift: '#fb7185',
  c: '#60a5fa',
  cpp: '#60a5fa',
  cc: '#60a5fa',
  h: '#7dd3fc',
  hpp: '#7dd3fc',
  cs: '#a855f7',
  // ドキュメント
  md: '#94a3b8',
  mdx: '#94a3b8',
  txt: '#94a3b8',
  pdf: '#f43f5e',
  // 画像
  png: '#a78bfa',
  jpg: '#a78bfa',
  jpeg: '#a78bfa',
  gif: '#a78bfa',
  svg: '#fbbf24',
  webp: '#a78bfa',
  ico: '#a78bfa',
  // 設定/ロック
  lock: '#64748b',
  env: '#84cc16',
  // シェル
  sh: '#22c55e',
  bash: '#22c55e',
  zsh: '#22c55e',
  ps1: '#3b82f6',
  bat: '#94a3b8',
  cmd: '#94a3b8'
};

const SPECIAL_NAME_COLOR: Record<string, string> = {
  'package.json': '#dc2626',
  'package-lock.json': '#dc2626',
  'tsconfig.json': '#3b82f6',
  'vite.config.ts': '#a855f7',
  'tauri.conf.json': '#facc15',
  'cargo.toml': '#f97316',
  'cargo.lock': '#f97316',
  dockerfile: '#0ea5e9',
  '.gitignore': '#f87171',
  '.gitattributes': '#f87171',
  '.env': '#84cc16',
  'readme.md': '#cbd5e1',
  'license': '#cbd5e1'
};

export function fileIconColor(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (SPECIAL_NAME_COLOR[lower]) return SPECIAL_NAME_COLOR[lower];
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return undefined;
  const ext = lower.slice(dot + 1);
  return EXT_COLOR[ext];
}

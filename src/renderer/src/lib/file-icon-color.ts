/**
 * ファイル名 (拡張子) からアイコン + 色を返す。
 * VSCode Material Icon Theme (PKief/material-icon-theme) を参考に、
 * 拡張子/特殊ファイル名ごとに固有のアイコン + カラーパレットを引く。
 *
 * - アイコンは lucide-react の中から最も意味の近いものを採用
 * - 色は Material Icon Theme の palette をベースに、ダーク背景で読める明度に調整
 * - `fileIconColor()` は後方互換で色だけ返す (呼び出し側が段階移行できるよう残す)
 */
import {
  BookOpen,
  Braces,
  Brush,
  Code2,
  Cog,
  Coffee,
  Container,
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileKey2,
  FileLock2,
  FileSpreadsheet,
  FileStack,
  FileText,
  FileVideo,
  FileType2,
  Gem,
  GitBranch,
  Globe,
  Hexagon,
  Image as ImageIcon,
  Key,
  Layers,
  Music,
  Package,
  Palette,
  Paintbrush,
  Scale,
  Settings,
  Shield,
  Snowflake,
  Sparkles,
  Terminal,
  Type as TypeIcon,
  Video,
  Wrench,
  Zap,
  type LucideIcon
} from 'lucide-react';

export interface FileIconDef {
  Icon: LucideIcon;
  color: string;
}

// ---------- 拡張子ベース ----------
const EXT: Record<string, FileIconDef> = {
  // TypeScript / JavaScript
  ts: { Icon: FileCode2, color: '#3178c6' },
  tsx: { Icon: FileCode2, color: '#3178c6' },
  mts: { Icon: FileCode2, color: '#3178c6' },
  cts: { Icon: FileCode2, color: '#3178c6' },
  'd.ts': { Icon: FileCode2, color: '#60a5fa' },
  js: { Icon: FileCode2, color: '#f7df1e' },
  jsx: { Icon: FileCode2, color: '#f7df1e' },
  mjs: { Icon: FileCode2, color: '#f7df1e' },
  cjs: { Icon: FileCode2, color: '#f7df1e' },

  // データ
  json: { Icon: Braces, color: '#facc15' },
  jsonc: { Icon: Braces, color: '#facc15' },
  json5: { Icon: Braces, color: '#facc15' },
  yaml: { Icon: FileStack, color: '#ef4444' },
  yml: { Icon: FileStack, color: '#ef4444' },
  toml: { Icon: Settings, color: '#a16207' },
  xml: { Icon: Code2, color: '#fb923c' },
  csv: { Icon: FileSpreadsheet, color: '#10b981' },
  tsv: { Icon: FileSpreadsheet, color: '#10b981' },
  xlsx: { Icon: FileSpreadsheet, color: '#10b981' },
  xls: { Icon: FileSpreadsheet, color: '#10b981' },
  ini: { Icon: Settings, color: '#94a3b8' },
  conf: { Icon: Settings, color: '#94a3b8' },
  cfg: { Icon: Settings, color: '#94a3b8' },
  env: { Icon: Key, color: '#84cc16' },

  // Web
  html: { Icon: Globe, color: '#f97316' },
  htm: { Icon: Globe, color: '#f97316' },
  css: { Icon: Paintbrush, color: '#ec4899' },
  scss: { Icon: Paintbrush, color: '#ec4899' },
  sass: { Icon: Paintbrush, color: '#ec4899' },
  less: { Icon: Paintbrush, color: '#0ea5e9' },
  vue: { Icon: FileCode2, color: '#42b883' },
  svelte: { Icon: FileCode2, color: '#ff3e00' },
  astro: { Icon: FileCode2, color: '#ff5d01' },

  // システム言語
  rs: { Icon: Cog, color: '#ce422b' },
  go: { Icon: Zap, color: '#06b6d4' },
  py: { Icon: FileCode2, color: '#3776ab' },
  rb: { Icon: Gem, color: '#cc342d' },
  java: { Icon: Coffee, color: '#f97316' },
  kt: { Icon: FileCode2, color: '#a855f7' },
  swift: { Icon: FileCode2, color: '#fb7185' },
  c: { Icon: FileCode2, color: '#60a5fa' },
  cpp: { Icon: FileCode2, color: '#60a5fa' },
  cc: { Icon: FileCode2, color: '#60a5fa' },
  h: { Icon: FileCode2, color: '#7dd3fc' },
  hpp: { Icon: FileCode2, color: '#7dd3fc' },
  cs: { Icon: FileCode2, color: '#a855f7' },
  php: { Icon: FileCode2, color: '#8993be' },
  dart: { Icon: FileCode2, color: '#0ea5e9' },
  lua: { Icon: FileCode2, color: '#2c2d72' },
  scala: { Icon: FileCode2, color: '#dc2626' },
  sol: { Icon: FileCode2, color: '#6b7280' },
  zig: { Icon: FileCode2, color: '#f7a41d' },

  // ドキュメント
  md: { Icon: BookOpen, color: '#60a5fa' },
  mdx: { Icon: BookOpen, color: '#1d4ed8' },
  txt: { Icon: FileText, color: '#94a3b8' },
  rst: { Icon: FileText, color: '#94a3b8' },
  pdf: { Icon: FileText, color: '#f43f5e' },
  doc: { Icon: FileText, color: '#2563eb' },
  docx: { Icon: FileText, color: '#2563eb' },

  // 画像
  png: { Icon: ImageIcon, color: '#a78bfa' },
  jpg: { Icon: ImageIcon, color: '#a78bfa' },
  jpeg: { Icon: ImageIcon, color: '#a78bfa' },
  gif: { Icon: FileImage, color: '#a78bfa' },
  bmp: { Icon: ImageIcon, color: '#a78bfa' },
  webp: { Icon: ImageIcon, color: '#a78bfa' },
  avif: { Icon: ImageIcon, color: '#a78bfa' },
  ico: { Icon: ImageIcon, color: '#facc15' },
  svg: { Icon: Palette, color: '#fbbf24' },

  // 動画
  mp4: { Icon: FileVideo, color: '#ec4899' },
  mov: { Icon: FileVideo, color: '#ec4899' },
  avi: { Icon: FileVideo, color: '#ec4899' },
  mkv: { Icon: FileVideo, color: '#ec4899' },
  webm: { Icon: Video, color: '#ec4899' },

  // オーディオ
  mp3: { Icon: FileAudio, color: '#f472b6' },
  wav: { Icon: FileAudio, color: '#f472b6' },
  ogg: { Icon: FileAudio, color: '#f472b6' },
  flac: { Icon: Music, color: '#f472b6' },
  m4a: { Icon: FileAudio, color: '#f472b6' },

  // フォント
  ttf: { Icon: TypeIcon, color: '#f59e0b' },
  otf: { Icon: TypeIcon, color: '#f59e0b' },
  woff: { Icon: TypeIcon, color: '#f59e0b' },
  woff2: { Icon: TypeIcon, color: '#f59e0b' },

  // アーカイブ
  zip: { Icon: FileArchive, color: '#f59e0b' },
  tar: { Icon: FileArchive, color: '#f59e0b' },
  gz: { Icon: FileArchive, color: '#f59e0b' },
  bz2: { Icon: FileArchive, color: '#f59e0b' },
  rar: { Icon: FileArchive, color: '#f59e0b' },
  '7z': { Icon: FileArchive, color: '#f59e0b' },

  // ロック / セキュリティ
  lock: { Icon: FileLock2, color: '#64748b' },
  pem: { Icon: Shield, color: '#16a34a' },
  key: { Icon: FileKey2, color: '#16a34a' },
  crt: { Icon: Shield, color: '#16a34a' },
  csr: { Icon: Shield, color: '#16a34a' },

  // シェル / スクリプト
  sh: { Icon: Terminal, color: '#22c55e' },
  bash: { Icon: Terminal, color: '#22c55e' },
  zsh: { Icon: Terminal, color: '#22c55e' },
  fish: { Icon: Terminal, color: '#22c55e' },
  ps1: { Icon: Terminal, color: '#3b82f6' },
  bat: { Icon: Terminal, color: '#94a3b8' },
  cmd: { Icon: Terminal, color: '#94a3b8' },

  // その他
  log: { Icon: FileText, color: '#64748b' },
  sqlite: { Icon: Layers, color: '#06b6d4' },
  db: { Icon: Layers, color: '#06b6d4' },
  sql: { Icon: Layers, color: '#e11d48' },
  wasm: { Icon: Hexagon, color: '#a855f7' },
  ico2: { Icon: Snowflake, color: '#7dd3fc' } // placeholder, unused
};

// ---------- 特殊ファイル名 ----------
const NAME: Record<string, FileIconDef> = {
  'package.json': { Icon: Package, color: '#dc2626' },
  'package-lock.json': { Icon: Package, color: '#64748b' },
  'pnpm-lock.yaml': { Icon: Package, color: '#f59e0b' },
  'yarn.lock': { Icon: Package, color: '#0ea5e9' },
  'bun.lockb': { Icon: Package, color: '#f9a03f' },
  'tsconfig.json': { Icon: Settings, color: '#3178c6' },
  'tsconfig.base.json': { Icon: Settings, color: '#3178c6' },
  'tsconfig.node.json': { Icon: Settings, color: '#3178c6' },
  'jsconfig.json': { Icon: Settings, color: '#f7df1e' },
  'vite.config.ts': { Icon: Zap, color: '#a855f7' },
  'vite.config.js': { Icon: Zap, color: '#a855f7' },
  'webpack.config.js': { Icon: Hexagon, color: '#60a5fa' },
  'rollup.config.js': { Icon: Sparkles, color: '#f97316' },
  'esbuild.config.js': { Icon: Zap, color: '#fbbf24' },
  'tauri.conf.json': { Icon: Settings, color: '#facc15' },
  'cargo.toml': { Icon: Cog, color: '#ce422b' },
  'cargo.lock': { Icon: Cog, color: '#64748b' },
  dockerfile: { Icon: Container, color: '#0ea5e9' },
  '.dockerignore': { Icon: Container, color: '#0ea5e9' },
  'docker-compose.yml': { Icon: Container, color: '#0ea5e9' },
  'docker-compose.yaml': { Icon: Container, color: '#0ea5e9' },
  makefile: { Icon: Wrench, color: '#a16207' },
  'gemfile': { Icon: Gem, color: '#cc342d' },
  'gemfile.lock': { Icon: Gem, color: '#64748b' },
  '.gitignore': { Icon: GitBranch, color: '#f87171' },
  '.gitattributes': { Icon: GitBranch, color: '#f87171' },
  '.gitmodules': { Icon: GitBranch, color: '#f87171' },
  '.gitkeep': { Icon: GitBranch, color: '#64748b' },
  '.env': { Icon: Key, color: '#84cc16' },
  '.env.local': { Icon: Key, color: '#84cc16' },
  '.env.development': { Icon: Key, color: '#84cc16' },
  '.env.production': { Icon: Key, color: '#84cc16' },
  '.eslintrc': { Icon: Brush, color: '#6366f1' },
  '.eslintrc.json': { Icon: Brush, color: '#6366f1' },
  '.eslintrc.js': { Icon: Brush, color: '#6366f1' },
  'eslint.config.js': { Icon: Brush, color: '#6366f1' },
  '.prettierrc': { Icon: Brush, color: '#db77a0' },
  '.prettierrc.json': { Icon: Brush, color: '#db77a0' },
  '.editorconfig': { Icon: Settings, color: '#94a3b8' },
  '.npmrc': { Icon: Settings, color: '#dc2626' },
  '.nvmrc': { Icon: Settings, color: '#16a34a' },
  'readme.md': { Icon: BookOpen, color: '#e0e0d6' },
  readme: { Icon: BookOpen, color: '#e0e0d6' },
  'readme-ja.md': { Icon: BookOpen, color: '#e0e0d6' },
  license: { Icon: Scale, color: '#eab308' },
  'license.md': { Icon: Scale, color: '#eab308' },
  'license.txt': { Icon: Scale, color: '#eab308' },
  changelog: { Icon: FileText, color: '#94a3b8' },
  'changelog.md': { Icon: FileText, color: '#94a3b8' },
  'claude.md': { Icon: Sparkles, color: '#d97757' }
};

/** 拡張子またはファイル名から icon + color を返す。未知なら undefined。 */
export function fileIcon(name: string): FileIconDef | undefined {
  const lower = name.toLowerCase();
  if (NAME[lower]) return NAME[lower];
  // d.ts は 2 ドット拡張の特別扱い
  if (lower.endsWith('.d.ts')) return EXT['d.ts'];
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return undefined;
  const ext = lower.slice(dot + 1);
  return EXT[ext];
}

/** 旧 API: 色だけ返す。他箇所 (Canvas 等) が参照している可能性があるので残す。 */
export function fileIconColor(name: string): string | undefined {
  return fileIcon(name)?.color;
}

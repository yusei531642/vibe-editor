// 拡張子から Monaco の言語ID への簡易マッピング。
// 未知の拡張子は "plaintext" を返す。

const EXT_MAP: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  yml: 'yaml',
  yaml: 'yaml',
  // Issue #77: TOML は Monaco 純正言語が無いので ini contribution で流用。
  //   TOML は ini の上位互換 (key=value + [section]) なので highlight は十分。
  toml: 'ini',
  xml: 'xml',
  svg: 'xml',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'powershell',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  php: 'php',
  cs: 'csharp',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  lua: 'lua',
  sql: 'sql',
  dockerfile: 'dockerfile'
};

export function detectLanguage(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? '';
  if (base.toLowerCase() === 'dockerfile') return 'dockerfile';
  const dot = base.lastIndexOf('.');
  if (dot < 0) return 'plaintext';
  const ext = base.slice(dot + 1).toLowerCase();
  return EXT_MAP[ext] ?? 'plaintext';
}

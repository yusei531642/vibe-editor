// main/preload/renderer で共有する型定義

export interface SessionInfo {
  /** セッションID（ファイル名から .jsonl を除いたもの） */
  id: string;
  /** JSONLファイルの絶対パス */
  path: string;
  /** 最初のユーザーメッセージ（タイトル用、長すぎる場合は省略） */
  title: string;
  /** メッセージ数（user + assistant） */
  messageCount: number;
  /** ファイル最終更新時刻 (ISO) */
  lastModifiedAt: string;
}

export interface SkillInfo {
  /** スキル名（SKILL.md frontmatter の name、なければディレクトリ名） */
  name: string;
  /** 概要説明（SKILL.md frontmatter の description を1行に整形） */
  description: string;
  /** SKILL.md の絶対パス */
  path: string;
  /** どのディレクトリ由来か（表示用） */
  source: 'user' | 'project';
}

export interface ClaudeMdFile {
  /** CLAUDE.md の絶対パス（存在しなければ projectRoot 直下の想定パス） */
  path: string;
  /** ファイル内容。ファイルが存在しない場合は null */
  content: string | null;
  /** ファイルが実在するか */
  exists: boolean;
}

export interface SaveResult {
  ok: boolean;
  path: string;
  error?: string;
}

/** git status --porcelain のエントリを構造化したもの */
export interface GitFileChange {
  /** リポジトリルートからの相対パス（POSIX区切り） */
  path: string;
  /** index側ステータス文字 (' ' | 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | '?') */
  indexStatus: string;
  /** worktree側ステータス文字 */
  worktreeStatus: string;
  /** 表示用ラベル（Modified / Added / Deleted / Untracked / Renamed ...） */
  label: string;
}

export interface GitStatus {
  ok: boolean;
  /** リポジトリでない / gitが使えない場合などのエラー理由 */
  error?: string;
  /** リポジトリルートの絶対パス */
  repoRoot?: string;
  branch?: string;
  files: GitFileChange[];
}

export type ThemeName =
  | 'claude-dark'
  | 'claude-light'
  | 'dark'
  | 'light'
  | 'midnight';

export type Density = 'compact' | 'normal' | 'comfortable';

export interface AppSettings {
  theme: ThemeName;
  uiFontFamily: string;
  uiFontSize: number;
  editorFontFamily: string;
  editorFontSize: number;
  terminalFontSize: number;
  density: Density;
  /** CLAUDE.md の自動保存を有効にするか */
  autoSave: boolean;
  /** 自動保存の間隔（ミリ秒） */
  autoSaveIntervalMs: number;
  // ---------- Claude Code 起動オプション ----------
  /** 起動コマンド（例: claude, claude.cmd, C:\path\to\claude.cmd） */
  claudeCommand: string;
  /** コマンドライン引数（空白区切り。ダブルクォートで空白を含められる） */
  claudeArgs: string;
  /** 作業ディレクトリ上書き（空ならプロジェクトルート） */
  claudeCwd: string;
  /** 最近使ったプロジェクトの絶対パス（新しい順、最大10件） */
  recentProjects: string[];
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'claude-dark',
  uiFontFamily:
    "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Hiragino Sans', 'Yu Gothic UI', sans-serif",
  uiFontSize: 13,
  editorFontFamily: "'Cascadia Code', 'Consolas', monospace",
  editorFontSize: 13,
  terminalFontSize: 13,
  density: 'normal',
  autoSave: false,
  autoSaveIntervalMs: 30000,
  claudeCommand: 'claude',
  claudeArgs: '',
  claudeCwd: '',
  recentProjects: []
};

export interface TerminalCreateOptions {
  /** 作業ディレクトリ */
  cwd: string;
  /** 起動コマンド（未指定なら既定シェル） */
  command?: string;
  /** コマンド引数 */
  args?: string[];
  cols: number;
  rows: number;
  /** 追加環境変数 */
  env?: Record<string, string>;
}

export interface TerminalCreateResult {
  ok: boolean;
  id?: string;
  error?: string;
  /** 実際に起動されたコマンド（トラブルシュート用） */
  command?: string;
}

export interface TerminalExitInfo {
  exitCode: number;
  signal?: number;
}

export interface GitDiffResult {
  ok: boolean;
  error?: string;
  path: string;
  /** HEAD に存在しない（=新規追加）なら true */
  isNew: boolean;
  /** 作業ツリーに存在しない（=削除）なら true */
  isDeleted: boolean;
  /** バイナリファイルで差分表示不可の場合 true */
  isBinary: boolean;
  /** HEAD の内容（新規なら ""） */
  original: string;
  /** 作業ツリーの内容（削除なら ""） */
  modified: string;
}

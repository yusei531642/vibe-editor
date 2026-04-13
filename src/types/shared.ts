// main/preload/renderer で共有する型定義

export type ThemeName =
  | 'claude-dark'
  | 'claude-light'
  | 'dark'
  | 'light'
  | 'midnight';

export type Density = 'compact' | 'normal' | 'comfortable';

export type Language = 'ja' | 'en';

export interface AppSettings {
  /** UI 言語 */
  language: Language;
  theme: ThemeName;
  uiFontFamily: string;
  uiFontSize: number;
  editorFontFamily: string;
  editorFontSize: number;
  terminalFontSize: number;
  density: Density;
  // ---------- Claude Code 起動オプション ----------
  claudeCommand: string;
  claudeArgs: string;
  claudeCwd: string;
  recentProjects: string[];
  /** 右側 Claude Code パネルの幅 (px) */
  claudeCodePanelWidth: number;
  // ---------- Codex ----------
  codexCommand: string;
  codexArgs: string;
  // ---------- チームプリセット ----------
  teamPresets: TeamPreset[];
}

export interface ClaudeCheckResult {
  ok: boolean;
  path?: string;
  error?: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  language: 'ja',
  theme: 'claude-dark',
  uiFontFamily:
    "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Hiragino Sans', 'Yu Gothic UI', sans-serif",
  uiFontSize: 14,
  editorFontFamily: "'Cascadia Code', 'Consolas', monospace",
  editorFontSize: 13,
  terminalFontSize: 13,
  density: 'normal',
  claudeCommand: 'claude',
  claudeArgs: '',
  claudeCwd: '',
  recentProjects: [],
  claudeCodePanelWidth: 460,
  codexCommand: 'codex',
  codexArgs: '',
  teamPresets: []
};

/** git status --porcelain のエントリ */
export interface GitFileChange {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  label: string;
}

export interface GitStatus {
  ok: boolean;
  error?: string;
  repoRoot?: string;
  branch?: string;
  files: GitFileChange[];
}

export interface GitDiffResult {
  ok: boolean;
  error?: string;
  path: string;
  isNew: boolean;
  isDeleted: boolean;
  isBinary: boolean;
  original: string;
  modified: string;
}

export interface SessionInfo {
  id: string;
  path: string;
  title: string;
  messageCount: number;
  lastModifiedAt: string;
}

// ---------- エージェント & チーム ----------

export type TerminalAgent = 'claude' | 'codex';

export type TeamRole = 'leader' | 'planner' | 'programmer' | 'researcher' | 'reviewer';

/** ランタイムのみ（永続化不要）。チーム所属タブは teamId で紐付く */
export interface Team {
  id: string;
  name: string;
}

export interface TeamMember {
  agent: TerminalAgent;
  role: TeamRole;
}

export interface TeamPreset {
  id: string;
  name: string;
  members: TeamMember[];
}

/** 保存されるチーム履歴メンバー。sessionId は Claude Code の --resume に渡す */
export interface TeamHistoryMember {
  role: TeamRole;
  agent: TerminalAgent;
  /** Claude Code の出力から抽出したセッションID。Codex や未キャプチャは null */
  sessionId: string | null;
}

/** 保存されるチーム履歴エントリ。プロジェクト単位で格納 */
export interface TeamHistoryEntry {
  id: string;
  name: string;
  projectRoot: string;
  createdAt: string;
  lastUsedAt: string;
  members: TeamHistoryMember[];
}

// ---------- ファイルツリー / 簡易エディタ ----------

export interface FileNode {
  name: string;
  /** projectRoot からの相対パス（POSIX区切り） */
  path: string;
  isDir: boolean;
}

export interface FileListResult {
  ok: boolean;
  error?: string;
  /** 引数で渡されたディレクトリ（相対パス）。ルートなら '' */
  dir: string;
  entries: FileNode[];
}

export interface FileReadResult {
  ok: boolean;
  error?: string;
  path: string;
  content: string;
  isBinary: boolean;
  /** UTF-8以外で読み取った場合の警告用 */
  encoding: string;
}

export interface FileWriteResult {
  ok: boolean;
  error?: string;
}

// ---------- ターミナル ----------

export interface TerminalCreateOptions {
  cwd: string;
  command?: string;
  args?: string[];
  cols: number;
  rows: number;
  env?: Record<string, string>;
  /** TeamHub 用のチーム識別子。設定すると同一 teamId のみ相互通信できる */
  teamId?: string;
  /** TeamHub 用のエージェント識別子。設定すると pty が TeamHub のレジストリに登録される */
  agentId?: string;
  /** TeamHub が注入したメッセージを判別するためのロール */
  role?: string;
}

export interface TerminalCreateResult {
  ok: boolean;
  id?: string;
  error?: string;
  command?: string;
}

export interface TerminalExitInfo {
  exitCode: number;
  signal?: number;
}

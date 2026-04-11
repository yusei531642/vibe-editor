// main/preload/renderer で共有する型定義

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
  // ---------- Claude Code 起動オプション ----------
  claudeCommand: string;
  claudeArgs: string;
  claudeCwd: string;
  recentProjects: string[];
  /** 右側 Claude Code パネルの幅 (px) */
  claudeCodePanelWidth: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
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
  claudeCodePanelWidth: 460
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

// ---------- ターミナル ----------

export interface TerminalCreateOptions {
  cwd: string;
  command?: string;
  args?: string[];
  cols: number;
  rows: number;
  env?: Record<string, string>;
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

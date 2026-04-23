// main/preload/renderer で共有する型定義

export type ThemeName =
  | 'claude-dark'
  | 'claude-light'
  | 'dark'
  | 'light'
  | 'midnight'
  | 'glass';

export type Density = 'compact' | 'normal' | 'comfortable';

export type Language = 'ja' | 'en';

/** Issue #75: AppSettings の現在スキーマ。破壊変更時に上げる。 */
export const APP_SETTINGS_SCHEMA_VERSION = 1;

export interface AppSettings {
  /** Issue #75: スキーマ番号。未設定 (旧データ) は 0 扱い */
  schemaVersion?: number;
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
  /**
   * ユーザー設定の作業ディレクトリ。空文字なら「現在のプロジェクトルート」を使う。
   * これは SettingsModal で明示的に編集される値であり、プロジェクトを開くたびに
   * 上書きしてはいけない (上書きすると SettingsModal の設定が実質無効化される)。
   */
  claudeCwd: string;
  /**
   * 最後に開いたプロジェクトルート。起動時にここから復元する。
   * ユーザー設定ではなく runtime の状態を永続化するためのスロット。
   */
  lastOpenedRoot: string;
  recentProjects: string[];
  /**
   * VSCode の "フォルダーをワークスペースに追加" 相当。
   * メインの `projectRoot` とは別に、サイドバーのファイルツリーで
   * 複数ルートを並べて表示するためのパス配列。git/terminal/MCP は
   * 引き続き `projectRoot` を基準に動作する。
   */
  workspaceFolders: string[];
  /** 右側 Claude Code パネルの幅 (px) */
  claudeCodePanelWidth: number;
  // ---------- Codex ----------
  codexCommand: string;
  codexArgs: string;
  // ---------- チームプリセット ----------
  teamPresets: TeamPreset[];
  /**
   * Issue #17: ターミナル間の受け渡し用メモ。
   * 入力中も自動保存し、再起動しても残る。
   */
  notepad: string;
}

export interface ClaudeCheckResult {
  ok: boolean;
  path?: string;
  error?: string;
}

/**
 * サイドバー左下のユーザーメニューで表示する情報。
 * Rust 側で whoami / tauri::package_info / std::env::consts::OS から集める。
 */
export interface AppUserInfo {
  username: string;
  version: string;
  /** "windows" | "macos" | "linux" | その他 std::env::consts::OS 値 */
  platform: string;
  /** Tauri ランタイムのバージョン */
  tauriVersion: string;
  /** WebView2 (Windows) / WKWebView (macOS) / WebKitGTK (Linux) のバージョン */
  webviewVersion: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
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
  lastOpenedRoot: '',
  recentProjects: [],
  workspaceFolders: [],
  claudeCodePanelWidth: 460,
  codexCommand: 'codex',
  codexArgs: '',
  teamPresets: [],
  notepad: ''
};

/** git status --porcelain のエントリ */
export interface GitFileChange {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  label: string;
  /**
   * rename / copy の場合、HEAD 側のパス (移動前の名前)。
   * 通常の変更は undefined。Diff 表示時に HEAD 側を引くためのキーとして使う。
   */
  originalPath?: string;
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
  /** ユーザーが手動でリネームしたタブ名。resume 時に復元する。null/未指定なら自動生成名 */
  customLabel?: string | null;
}

/** 保存されるチーム履歴エントリ。プロジェクト単位で格納 */
export interface TeamHistoryEntry {
  id: string;
  name: string;
  projectRoot: string;
  createdAt: string;
  lastUsedAt: string;
  members: TeamHistoryMember[];
  /**
   * Phase 5: Canvas モードで使う配置状態。
   * 各メンバーの { agentId, x, y, width, height } と viewport を保持。
   * IDE モードからは無視される (後方互換)。
   */
  canvasState?: TeamCanvasState;
}

export interface TeamCanvasNode {
  agentId: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
}

export interface TeamCanvasState {
  nodes: TeamCanvasNode[];
  viewport: { x: number; y: number; zoom: number };
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
  /** Issue #65: 読み取った時点の mtime (ms since epoch)。save 時の external-change 検出に使う */
  mtimeMs?: number;
}

export interface FileWriteResult {
  ok: boolean;
  error?: string;
  /** Issue #65: 書き込み後の mtime。次回 save 時の比較基準に使う */
  mtimeMs?: number;
  /** Issue #65: expected mtime と現状が食い違った場合 true。ok=false かつ conflict=true でユーザーに確認 */
  conflict?: boolean;
}

// ---------- ターミナル ----------

export interface TerminalCreateOptions {
  cwd: string;
  /**
   * `cwd` が無効(存在しない or ディレクトリでない)だった場合に
   * main プロセス側で代替に使うフォールバックパス。通常は
   * 現在開いているプロジェクトルートを渡す。これが無効な場合は
   * 更に `process.cwd()` にフォールバックする。
   */
  fallbackCwd?: string;
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
  /**
   * Codex 用のシステム指示文。Claude の --append-system-prompt と同等の役割を
   * 果たし、main プロセス側で一時ファイルに書き出して
   * `-c model_instructions_file=<path>` を args に差し込む。
   */
  codexInstructions?: string;
}

export interface TerminalCreateResult {
  ok: boolean;
  id?: string;
  error?: string;
  command?: string;
  /**
   * 致命的ではない警告メッセージ(例: 設定された cwd が無効でフォールバックした、等)。
   * UI 側で status ライン / トースト / terminal に表示する用途。
   */
  warning?: string;
}

export interface TerminalExitInfo {
  exitCode: number;
  signal?: number;
}

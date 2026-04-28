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
export const APP_SETTINGS_SCHEMA_VERSION = 6;

/**
 * ユーザーが自由に追加できるエージェントの設定。
 * built-in の claude / codex 以外を登録するためのレコード。
 *  - id: 起動時の識別子。'claude' / 'codex' は予約語 (バリデーションで弾く)
 *  - name: UI 表示名 (Canvas / Team ビルダーに出る)
 *  - command / args / cwd: pty spawn 用の起動パラメータ
 *  - color: Canvas カードの accent カラー (省略時は --accent)
 */
export interface AgentConfig {
  id: string;
  name: string;
  command: string;
  args: string;
  cwd?: string;
  color?: string;
}

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
  /**
   * ターミナル (xterm) のフォントファミリ。
   * 未設定なら editorFontFamily にフォールバック。既定は素直で崩れにくい OS mono。
   */
  terminalFontFamily?: string;
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
  /**
   * Issue #17: ターミナル間の受け渡し用メモ。
   * 入力中も自動保存し、再起動しても残る。
   */
  notepad: string;
  /**
   * 初回セットアップウィザードを完了したか。
   * false / undefined の場合、起動時にウィザードを表示する。
   * 設定モーダルから再実行するとこの値が false に戻る。
   */
  hasCompletedOnboarding?: boolean;
  /**
   * Claude / Codex 以外のカスタムエージェント。
   * 設定モーダルの「エージェント」グループで CRUD できる。
   */
  customAgents?: AgentConfig[];
  /**
   * Team 起動時に vibe-team MCP を自動セットアップするか。
   * false のとき setupTeamMcp 呼び出しがスキップされ、ユーザーは MCP タブの
   * 手順に従って手動で ~/.claude.json / ~/.codex/config.toml を編集する。
   */
  mcpAutoSetup?: boolean;
  /**
   * Issue #161: webview zoom factor (0.5〜3.0)。Ctrl+=/-/0 や Shift+wheel で変動。
   * 旧実装は永続化していなかったため、再起動後に内部 current=1.0 と実際の zoom が
   * 食い違って Ctrl+= で逆に縮む現象が起きていた。
   */
  webviewZoom?: number;
  /**
   * Issue #250: ファイルツリーの展開状態をワークスペースルート毎に永続化する。
   *   key   = ルート絶対パス
   *   value = 展開済みディレクトリの相対パス配列 (POSIX 区切り、'' は含めない)
   */
  fileTreeExpanded?: Record<string, string[]>;
  /**
   * Issue #250: 折り畳み済みワークスペースルート (絶対パス) の配列。
   * primary は通常展開、ユーザーが手動で折り畳んだものだけここに残る。
   */
  fileTreeCollapsedRoots?: string[];
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
    "'Inter Variable', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Hiragino Sans', 'Yu Gothic UI', sans-serif",
  uiFontSize: 14,
  // バンドル済み JetBrains Mono Variable を最優先。OS 未インストールでも綺麗に出る。
  editorFontFamily:
    "'JetBrains Mono Variable', 'Geist Mono Variable', 'Cascadia Code', 'Consolas', monospace",
  editorFontSize: 13,
  // ターミナルはセル幅の安定が最優先。Canvas モードは DOM renderer 固定で
  // customGlyphs が効かないため、罫線/濃淡 glyph を OS mono から素直に取る。
  terminalFontFamily:
    "'Cascadia Mono', 'Cascadia Code', Consolas, 'Lucida Console', 'Segoe UI Symbol', monospace",
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
  notepad: '',
  hasCompletedOnboarding: false,
  customAgents: [],
  mcpAutoSetup: true,
  fileTreeExpanded: {},
  fileTreeCollapsedRoots: []
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
  /** Rust 側で事前計算した epoch ms。SessionsPanel の再描画ごとの Date.parse を避ける。 */
  lastModifiedMs?: number;
}

// ---------- エージェント & チーム ----------

/**
 * エージェント識別子。
 * built-in の 'claude' / 'codex' に加えて、customAgents の id (任意文字列) も取り得る。
 * 以前は literal union だったが、カスタムエージェント対応のため string に緩めた。
 */
export type TerminalAgent = string;

/**
 * 旧固定 5 種ロール。後方互換のため string alias を維持しつつ、
 * 実体は `RoleProfile.id` (任意文字列) で識別される。
 */
export type TeamRole = string;

/** ロールプロファイル — チームメンバーの役割テンプレ。
 *  built-in (アプリ同梱) と user (~/.vibe-editor/role-profiles.json) の合成で運用。 */
export interface RoleProfile {
  schemaVersion: 1;
  id: string;
  /** built-in (同梱) か user (ユーザー定義 / override) か */
  source: 'builtin' | 'user';
  i18n: {
    en: { label: string; description: string };
    ja?: { label: string; description: string };
  };
  visual: {
    /** #rrggbb */
    color: string;
    /** 1 char glyph */
    glyph: string;
  };
  prompt: {
    /** placeholder: {teamName} {selfLabel} {selfDescription} {roster} {tools} {globalPreamble} */
    template: string;
    /** 日本語版テンプレ (任意)。無ければ template を流用 */
    templateJa?: string;
  };
  permissions: {
    canRecruit: boolean;
    canDismiss: boolean;
    canAssignTasks: boolean;
    canCreateRoleProfile: boolean;
  };
  defaultEngine: 'claude' | 'codex';
  /** チーム内で唯一しか居られない (Leader 用) */
  singleton?: boolean;
}

/** ~/.vibe-editor/role-profiles.json のスキーマ */
export interface RoleProfilesFile {
  schemaVersion: 1;
  /** built-in を id ベースで部分上書き */
  overrides?: Record<string, Partial<Omit<RoleProfile, 'id' | 'source' | 'schemaVersion'>>>;
  /** 完全に新規追加された role profile (source: 'user') */
  custom?: RoleProfile[];
  /** 全エージェント共通の preamble (任意) */
  globalPreamble?: { en?: string; ja?: string };
  /** 受信時のメッセージタグ書式。default = "[Team <- {fromLabel}] {message}" */
  messageTagFormat?: string;
}

/** ランタイムのみ（永続化不要）。チーム所属タブは teamId で紐付く */
export interface Team {
  id: string;
  name: string;
}

export interface TeamMember {
  agent: TerminalAgent;
  role: TeamRole;
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
  /** 検出された encoding。"utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be" | "utf-32le" | "utf-32be" | "shift_jis" | "lossy" | "binary" */
  encoding: string;
  /** Issue #65: 読み取った時点の mtime (ms since epoch)。save 時の external-change 検出に使う */
  mtimeMs?: number;
  /** Issue #104: 読み取った時点の size。mtime 解像度の補完として save 時に併用される */
  sizeBytes?: number;
  /** Issue #119: 読み取った時点の SHA-256 (hex)。同サイズ・1 秒以内変更の検出補完に使う */
  contentHash?: string;
}

export interface FileWriteResult {
  ok: boolean;
  error?: string;
  /** Issue #65: 書き込み後の mtime。次回 save 時の比較基準に使う */
  mtimeMs?: number;
  /** Issue #104: 書き込み後の size。次回 save 時の比較基準に使う */
  sizeBytes?: number;
  /** Issue #119: 書き込み後の SHA-256 (hex)。次回 save 時の比較基準に使う */
  contentHash?: string;
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

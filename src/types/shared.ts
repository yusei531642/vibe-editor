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

export type StatusMascotVariant = 'vibe' | 'spark' | 'mono';

/**
 * Issue #75: AppSettings の現在スキーマ。
 * Issue #449 で claudeArgs / codexArgs / customAgents[].args の Unicode dash (U+2013 等)
 * を ASCII '-' に正規化する migration を追加し v10。
 * Issue #618 で `terminalForceUtf8` (default true) を追加し v11。Windows + cmd.exe / PowerShell
 * で起動時に `chcp 65001` を inject して CP932 シェルでの U+FFFD 化を防ぐ。
 */
export const APP_SETTINGS_SCHEMA_VERSION = 11;

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
  /** ステータスバー左側に表示するキャラクターの見た目 */
  statusMascotVariant?: StatusMascotVariant;
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
  /**
   * Issue #337: 左サイドバーの幅 (px)。ドラッグハンドルでリサイズ可能。
   * default 272, min 200, max 600。異常値は migrate / runtime clamp で 272 にリセット。
   */
  sidebarWidth: number;
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
  /**
   * Issue #618: Windows ConPTY で cmd.exe / PowerShell を起動する際に、初期コマンドとして
   * `chcp 65001` 等を inject して console output を UTF-8 へ強制するか。default true。
   *
   * - cmd.exe: `chcp 65001 > nul\r` を流す (CP932 → UTF-8)。`dir` 等の漢字ファイル名や
   *   `python -c "print('日本語')"` の出力が U+FFFD 化するのを防ぐ。
   * - PowerShell (pwsh / powershell): `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); chcp 65001 > $null\r`
   *   を流す。
   * - その他のシェル (bash / zsh / fish / nu) や非 Windows 環境では何もしない (no-op)。
   *
   * OEM コードページを意図的に使いたい (= chcp 932 のままにしたい) ユーザーは
   * 設定で false に opt-out できる。
   */
  terminalForceUtf8?: boolean;
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
  // Issue #346: Nerd Font 同梱の JetBrainsMono Nerd Font Mono を最優先。
  // Powerline / Devicons / Material Icons の glyph を OS 未インストールでも提供する。
  // セル幅安定のため Mono variant (single-cell width icon) を採用。
  // 罫線 / 濃淡 glyph は同フォント内に揃っており、ロゴ ASCII art が tofu 化しない。
  terminalFontFamily:
    "'JetBrainsMono Nerd Font Mono', 'JetBrains Mono Variable', 'Cascadia Mono', 'Cascadia Code', Consolas, 'Lucida Console', 'Segoe UI Symbol', monospace",
  terminalFontSize: 13,
  density: 'normal',
  statusMascotVariant: 'vibe',
  claudeCommand: 'claude',
  claudeArgs: '',
  claudeCwd: '',
  lastOpenedRoot: '',
  recentProjects: [],
  workspaceFolders: [],
  claudeCodePanelWidth: 460,
  sidebarWidth: 272,
  codexCommand: 'codex',
  codexArgs: '',
  notepad: '',
  hasCompletedOnboarding: false,
  customAgents: [],
  mcpAutoSetup: true,
  fileTreeExpanded: {},
  fileTreeCollapsedRoots: [],
  // Issue #618: Windows + cmd.exe / PowerShell で UTF-8 を強制する (CP932 化対策)。
  // 既存ユーザーも v11 migration で true 既定が入る。
  terminalForceUtf8: true
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

/**
 * Issue #326: 設定モーダルのログビューア用。Rust 側 `logs_read_tail` の応答に対応。
 * 構造体は `src-tauri/src/commands/logs.rs` の `ReadLogTailResponse` と一致させる。
 */
export interface ReadLogTailResponse {
  /** ログ末尾の文字列。`empty=true` のとき空文字列 */
  content: string;
  /** ログファイルの絶対パス (表示用) */
  path: string;
  /** maxBytes でクリップしたか (= ファイルがそれ以上長い) */
  truncated: boolean;
  /** ファイル不在 / size=0 のとき true */
  empty: boolean;
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

/**
 * Issue #513: 動的ロール (Leader が `team_recruit({ role_definition: ... })` で生成した
 * ロール定義) を永続化する 1 件分のエントリ。
 *
 * Hub state 内の `DynamicRole` (Rust struct) と camelCase 互換 (`#[serde(rename_all =
 * "camelCase")]`)。`team_id` を持つことで「どのチームで作られたか」を保持し、再起動時の
 * `register_team` 経路で該当 team_id の entries だけを `replace_dynamic_roles()` で
 * Hub に投入する。
 *
 * `expiresAt` は将来的な「使い捨てロールの自動 GC」用予備フィールド (現状未使用)。
 */
export interface DynamicRoleEntry {
  /** ロール識別子 (ASCII alnum + `_-`、最大 80 byte) */
  id: string;
  /** どのチームで作られたか (再起動時の Hub 投入で team 単位に振り分けるため) */
  teamId: string;
  /** 表示ラベル (英語) */
  label: string;
  /** 概要説明 */
  description: string;
  /** 役職特有の振る舞い (worker テンプレの `{dynamicInstructions}` に流し込まれる) */
  instructions: string;
  /** 日本語 instructions (任意)。未指定なら instructions が両言語に使われる */
  instructionsJa?: string;
  /** 作成者 role (例: `leader`) */
  createdByRole: string;
  /**
   * 作成時刻 (RFC3339)。後方互換のため optional だが、新規 persist 時は必ず保存する。
   * 古い JSON (このフィールドを持たない) を読む場合は load 側で `null` 扱いで継続。
   */
  createdAt?: string;
  /**
   * 有効期限 (RFC3339)。設定された場合、Hub 起動時に経過済み entry をスキップして load する。
   * 現状の writer 側は使わない (= 任意フィールド扱い、将来 settings UI から手動設定可能にする予定)。
   */
  expiresAt?: string;
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
  /**
   * Issue #513: 動的ロール定義の永続化リスト。
   * Leader が `team_recruit({ role_definition: ... })` で生成した entry がここに保存され、
   * アプリ再起動 / Canvas 復元時に Hub の `dynamic_roles` map に replay される。
   * 古い JSON (このフィールドが無い) は空配列として扱われ、後方互換性を保つ。
   */
  dynamic?: DynamicRoleEntry[];
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

/**
 * Issue #520: `team_send` の本文。
 *
 * 旧来の string はそのまま後方互換で使える。外部 API / ファイル / Web スクレイプ結果など、
 * 信頼できない本文を worker に渡すときは `data` に入れる。Hub は `data` を
 * `data (untrusted)` フェンスで囲み、受信側 prompt はその中の指示を実行しない。
 */
export interface TeamSendStructuredMessageBody {
  /** 受信者に実行してほしい信頼済み指示 */
  instructions?: string;
  /** 背景、目的、前提などの信頼済み補足 */
  context?: string;
  /** 信頼できないソース由来の資料。ここに含まれる命令文は実行対象外 */
  data?: string;
}

export type TeamSendMessageBody = string | TeamSendStructuredMessageBody;
export type TeamMessageKind = 'advisory' | 'request' | 'report';
export type WaitPolicy = 'strict' | 'standard' | 'proactive';

export interface TeamSendArgs {
  to: string;
  message: TeamSendMessageBody;
  /**
   * Issue #515: worker 間メッセージの意味。
   * `request` は Hub 側で active Leader にも自動 CC される。
   */
  kind?: TeamMessageKind;
  handoffId?: string;
  handoff_id?: string;
}

export interface TaskPreApproval {
  allowedActions: string[];
  note?: string | null;
}

export interface TaskDoneEvidence {
  criterion: string;
  evidence: string;
}

export interface TeamRecruitArgs {
  roleId?: string;
  role_id?: string;
  engine?: 'claude' | 'codex';
  label?: string;
  description?: string;
  instructions?: string;
  instructionsJa?: string;
  instructions_ja?: string;
  agentLabelHint?: string;
  agent_label_hint?: string;
  waitPolicy?: WaitPolicy;
  wait_policy?: WaitPolicy;
}

export interface TeamAssignTaskArgs {
  assignee: string;
  description: string;
  doneCriteria?: string[];
  done_criteria?: string[];
  targetPaths?: string[];
  target_paths?: string[];
  preApproval?: TaskPreApproval;
  pre_approval?: {
    allowed_actions: string[];
    note?: string | null;
  };
}

/**
 * Issue #518: チーム単位の engine policy。`team_info` response の `enginePolicy` /
 * `team_create_leader({engine_policy})` 引数 / `team_recruit` の policy 違反時の
 * 構造化エラー (`recruit_engine_policy_violation`) で参照される。
 *
 * - `mixed_allowed` (既定): claude / codex 混在 OK。レガシーチームもこの扱い。
 * - `claude_only`: `engine: 'codex'` の recruit を拒否。
 * - `codex_only`: `engine: 'claude'` の recruit を拒否。HR 経由採用で Codex 指定が
 *   消えて Claude にリセットされる事故を構造的に防ぐ。
 *
 * snake_case literal は Rust 側 enum `EnginePolicyKind` の `#[serde(rename_all = "snake_case")]`
 * 出力と一致する wire format。既存の lowercase union (`HandoffStatus` 等) と異なり 2-語
 * になるが、Rust 側 enum variant (`ClaudeOnly` 等) との対応を直訳した形。
 */
export type EnginePolicyKind = 'mixed_allowed' | 'claude_only' | 'codex_only';

export interface EnginePolicy {
  kind: EnginePolicyKind;
  /**
   * チーム既定の engine。`team_recruit` で `engine` 引数が省略されたときに使われる。
   * `claude_only` / `codex_only` のときは実質強制。`mixed_allowed` では `undefined` (= field 省略)
   * の場合 role profile の default engine が使われる。
   *
   * 「未設定」と「空文字明示」を distinguishable に保つため、空文字 `""` は許容しない
   * (Rust 側 `Option<String>` + `skip_serializing_if = "Option::is_none"` と整合)。
   *
   * **scope**: 本 policy は built-in 2 engine (`claude` / `codex`) のみをガード対象とする。
   * `TerminalAgent` (string alias) で表現される custom agents (例: `gemini` 等のユーザー登録
   * カスタム engine) は **engine_policy の検証対象外**で、`team_recruit` で自由に渡せる。
   * Rust 側 `EnginePolicy::validate` も `("codex", ClaudeOnly)` / `("claude", CodexOnly)` の
   * 2 ペアだけ拒否する設計で、custom 値は素通りする。
   */
  defaultEngine?: 'claude' | 'codex';
}

/** Canvas 上で同時運用する「組織」の表示・復元用メタデータ。 */
export interface TeamOrganizationMeta {
  /** 組織単位の識別子。通常は teamId と同じ。 */
  id: string;
  name: string;
  /** #rrggbb */
  color: string;
  /** 同時起動プリセット内での表示順。 */
  index?: number;
  /** どのプリセットから作られたか。手動作成や旧履歴では未設定。 */
  presetId?: string;
}

/** 保存されるチーム履歴メンバー。sessionId は Claude Code の --resume に渡す */
export interface TeamHistoryMember {
  role: TeamRole;
  agent: TerminalAgent;
  /** TeamHub / Canvas 上の配送先 identity。旧履歴では未設定 */
  agentId?: string | null;
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
  /** Issue #370: Canvas で複数組織を同時運用したときの所属表示・復元用情報。 */
  organization?: TeamOrganizationMeta;
  /**
   * Phase 5: Canvas モードで使う配置状態。
   * 各メンバーの { agentId, x, y, width, height } と viewport を保持。
   * IDE モードからは無視される (後方互換)。
   */
  canvasState?: TeamCanvasState;
  /** Issue #359: 最新 handoff の参照。本体は ~/.vibe-editor/handoffs/ に保存する。 */
  latestHandoff?: HandoffReference;
  /** Issue #470: TeamHub orchestration state の軽量要約 */
  orchestration?: TeamOrchestrationSummary;
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

/* ---------- Team Presets (Issue #522) ---------- */

/**
 * Team Preset の 1 ロール分。Leader 起動後に Leader 自身が `team_recruit` を順次呼ぶ
 * 想定で、`agent` は terminal kind (claude / codex / ...)、`customInstructions` は
 * Leader が recruit 時に渡す追加指示の生テキスト。
 */
export interface TeamPresetRole {
  roleProfileId: string;
  agent: TerminalAgent;
  /** UI 表示用の任意ラベル (空なら role profile の i18n ラベルを使う) */
  label?: string | null;
  /** Leader の team_recruit 時に追加する custom_instructions */
  customInstructions?: string | null;
}

export interface TeamPresetLayoutEntry {
  x: number;
  y: number;
  width?: number | null;
  height?: number | null;
}

/**
 * roleProfileId をキーにした相対座標 + size。Canvas store の addCards に渡す配置ヒント。
 * 同 roleProfileId が複数並ぶ preset は今回未対応 (UI 側で重複チェック)。
 */
export interface TeamPresetLayout {
  byRole: Record<string, TeamPresetLayoutEntry>;
}

/**
 * Issue #522: 「うまくいったチーム編成」を保存・再構築するための設計図。
 * 1 preset = `~/.vibe-editor/presets/<id>.json`。
 */
export interface TeamPreset {
  schemaVersion: 1;
  id: string;
  name: string;
  description?: string | null;
  createdAt: string;
  updatedAt?: string | null;
  /** UI フィルタ用の表示メタ ('claude' / 'codex' / 'mixed') */
  enginePolicy: 'claude' | 'codex' | 'mixed' | string;
  roles: TeamPresetRole[];
  layout?: TeamPresetLayout | null;
}

export interface TeamPresetMutationResult {
  ok: boolean;
  preset?: TeamPreset | null;
  error?: string | null;
}

export type HandoffKind = 'leader' | 'worker' | 'terminal';
export type HandoffStatus =
  | 'created'
  | 'injected'
  | 'acked'
  | 'started'
  | 'acknowledged'
  | 'retired'
  | 'failed';

export interface HandoffReference {
  id: string;
  kind: HandoffKind | string;
  status: HandoffStatus | string;
  createdAt: string;
  updatedAt?: string;
  jsonPath: string;
  markdownPath: string;
  fromAgentId?: string | null;
  toAgentId?: string | null;
  replacementForAgentId?: string | null;
}

export interface HandoffContent {
  summary: string;
  decisions: string[];
  filesTouched: string[];
  openTasks: string[];
  risks: string[];
  nextActions: string[];
  verification: string[];
  notes: string[];
  terminalSnapshot?: string | null;
}

export interface HandoffCreateRequest {
  projectRoot: string;
  teamId?: string | null;
  kind: HandoffKind | string;
  fromAgentId?: string | null;
  fromRole?: string | null;
  fromAgent?: string | null;
  fromTitle?: string | null;
  sourceSessionId?: string | null;
  replacementForAgentId?: string | null;
  retireAfterAck: boolean;
  trigger: string;
  content: HandoffContent;
}

export interface HandoffCheckpoint extends HandoffReference {
  schemaVersion: number;
  projectRoot: string;
  teamId?: string | null;
  fromRole?: string | null;
  fromAgent?: string | null;
  fromTitle?: string | null;
  sourceSessionId?: string | null;
  retireAfterAck: boolean;
  trigger: string;
  content: HandoffContent;
}

export interface HandoffCreateResult {
  ok: boolean;
  handoff?: HandoffCheckpoint | null;
  error?: string | null;
}

export interface HandoffMutationResult {
  ok: boolean;
  handoff?: HandoffCheckpoint | null;
  error?: string | null;
}

export interface TeamOrchestrationSummary {
  statePath: string;
  activeLeaderAgentId?: string | null;
  pendingTaskCount: number;
  workerReportCount: number;
  blockedByHumanGate: boolean;
  blockedReason?: string | null;
  requiredHumanDecision?: string | null;
  latestHandoffId?: string | null;
  latestHandoffStatus?: string | null;
  updatedAt: string;
}

/**
 * Issue #514: TeamHub orchestration state の TS 投影。
 * Rust 側 `commands/team_state.rs` の `TeamOrchestrationState` (camelCase) に揃える。
 * dashboard / 履歴復元 / 統合フェーズビューなど renderer 全体で参照する。
 */
export interface TeamTaskSnapshot {
  id: number;
  assignedTo: string;
  description: string;
  status: string;
  createdBy: string;
  createdAt: string;
  updatedAt?: string | null;
  summary?: string | null;
  blockedReason?: string | null;
  nextAction?: string | null;
  artifactPath?: string | null;
  blockedByHumanGate?: boolean;
  requiredHumanDecision?: string | null;
  targetPaths?: string[];
  lockConflicts?: FileLockConflictSnapshot[];
  preApproval?: TaskPreApproval | null;
  doneCriteria?: string[];
  doneEvidence?: TaskDoneEvidence[];
}

export interface FileLockConflictSnapshot {
  path: string;
  holderAgentId: string;
  holderRole: string;
  acquiredAt: string;
}

export interface HumanGateState {
  blocked?: boolean;
  reason?: string | null;
  requiredDecision?: string | null;
  source?: string | null;
  updatedAt?: string | null;
}

export interface HandoffLifecycleEvent {
  handoffId: string;
  status: string;
  agentId?: string | null;
  note?: string | null;
  createdAt: string;
}

/**
 * `team_report` findings の TS 投影。Rust 側 `TeamReportFinding` (camelCase) と一致させる。
 */
export interface TeamReportFinding {
  severity: string;
  file: string;
  message: string;
}

/**
 * `team_reports` backlog の TS 投影。Rust 側 `TeamReportSnapshot` (camelCase) と一致させる。
 */
export interface TeamReportSnapshot {
  id: string;
  taskId: string;
  taskIdNum?: number;
  fromRole: string;
  fromAgentId: string;
  status: string;
  summary: string;
  findings?: TeamReportFinding[];
  changedFiles?: string[];
  artifactRefs?: string[];
  nextActions?: string[];
  createdAt: string;
}

export interface TeamOrchestrationState {
  schemaVersion: number;
  projectRoot: string;
  teamId: string;
  activeLeaderAgentId?: string | null;
  latestHandoff?: HandoffReference | null;
  tasks: TeamTaskSnapshot[];
  pendingTasks: TeamTaskSnapshot[];
  workerReports: WorkerReport[];
  teamReports?: TeamReportSnapshot[];
  humanGate: HumanGateState;
  nextActions: string[];
  handoffEvents: HandoffLifecycleEvent[];
  updatedAt: string;
}

/**
 * Issue #516: Leader が複数 worker の成果を統合フェーズで突き合わせるための構造化フィールド。
 * 既存の単発 `summary` / `nextAction` / `artifactPath` と重複してもよい (後方互換目的)。
 * 全フィールド optional で、必要な軸だけ埋めて返してよい。
 */
export interface WorkerReportPayload {
  /** 調査・実装で得られた発見・観察結果 (markdown / プレーンテキスト) */
  findings?: string;
  /** 採用方針の推奨 (Leader 向けの提案) */
  proposal?: string;
  /** リスク・既知の懸念事項 (Leader が他 worker と突き合わせるリスト) */
  risks?: string[];
  /** 次にやるべき具体的な行動 (top-level nextAction と重複可) */
  nextAction?: string;
  /** 複数の生成物パス (top-level artifactPath より柔軟) */
  artifacts?: string[];
}

/**
 * `team_update_task` の引数スキーマ (TS 側でも参照できるよう再掲)。
 * Issue #516 で `reportPayload` を追加。
 */
export interface UpdateTaskArgs {
  taskId: number;
  status: 'pending' | 'in_progress' | 'done' | 'completed' | 'blocked' | string;
  summary?: string;
  blockedReason?: string;
  nextAction?: string;
  artifactPath?: string;
  blockedByHumanGate?: boolean;
  requiredHumanDecision?: string;
  reportKind?: string;
  doneEvidence?: TaskDoneEvidence[];
  done_evidence?: TaskDoneEvidence[];
  /** Issue #516: 構造化された worker report */
  reportPayload?: WorkerReportPayload;
}

/**
 * `worker_reports` の TS 投影。Rust 側 `WorkerReportSnapshot` (camelCase) と完全に一致させる。
 */
export interface WorkerReport {
  id: string;
  taskId?: number;
  fromRole: string;
  fromAgentId: string;
  kind: string;
  summary: string;
  blockedReason?: string;
  nextAction?: string;
  artifactPath?: string;
  /** Issue #516: 構造化 payload (Leader の統合フェーズで使う) */
  payload?: WorkerReportPayload;
  createdAt: string;
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

/**
 * Issue #592: ファイルツリー右クリックメニュー (VS Code 互換) で叩く
 * `files_create` / `files_create_dir` / `files_rename` / `files_delete` / `files_copy`
 * の共通レスポンス。`path` には操作後の対象パスを返す (作成・rename・copy なら新パス、
 * 削除なら削除した元パス)。
 */
export interface FileMutationResult {
  ok: boolean;
  error?: string;
  /** 操作対象の最終的な相対パス (POSIX 区切り) */
  path: string;
}

// ---------- ターミナル ----------

export interface TerminalCreateOptions {
  /**
   * Issue #285: renderer 側が `terminal:data:{id}` 等を pre-subscribe してから
   * spawn できるよう、client が事前生成した terminal id を渡せる。`[A-Za-z0-9_-]{1,64}`
   * のみ有効で、不正値や未指定の場合は Rust 側で UUID を再生成して採用する。
   */
  id?: string;
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
   * Issue #271: React mount をまたいで同じ PTY を識別する論理キー。永続化はしない。
   * IDE: `term:${tab.id}`、Canvas: `canvas-term:${node.id}` / `canvas-agent:${node.id}` 等。
   * Vite HMR の React Refresh でコンポーネントが unmount/remount されたとき、
   * 同じ sessionKey を持つ既存 PTY に attach して一斉初期化を防ぐために使う。
   */
  sessionKey?: string;
  /**
   * Issue #271: true の場合、Rust 側 preflight で同じ sessionKey / agentId の生存 PTY が
   * あれば spawn せず既存 id を返す。HMR 復帰経路用。
   */
  attachIfExists?: boolean;
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
  /**
   * Issue #271: `attachIfExists` により既存 PTY に接続した場合 true。
   * 新規 spawn の場合は false / undefined。renderer は新規 spawn 時にだけ
   * initialMessage 自動送信や session id watcher のセットアップを行いたいケースで参照する。
   */
  attached?: boolean;
  /**
   * Issue #285 follow-up: attach 経路で renderer に渡す既存 PTY の直近出力 snapshot。
   * HMR remount や Canvas/IDE 切替で xterm が新規生成されると、既存 PTY の banner /
   * prompt は emit 済みで listener には届かない。Rust 側で直前 64 KiB を保持し、
   * attach hit 時にここに乗せて返すので renderer は最初に term.write(replay) する。
   * 新規 spawn 経路 / snapshot が空のときは undefined。
   */
  replay?: string;
}

export interface TerminalExitInfo {
  exitCode: number;
  signal?: number;
}

// ---------- IDE 端末タブ永続化 (Issue #661) ----------

/** terminal-tabs.json schema 版番号。format 互換が壊れる変更で bump する。 */
export const TERMINAL_TABS_SCHEMA_VERSION = 1;

/**
 * 1 個の terminal タブを再起動跨ぎで復元するためのスナップショット。
 *
 * 永続化先は `~/.vibe-editor/terminal-tabs.json`。`team-history.json` (Canvas / TeamHub
 * 配下のタブ) とは独立した SSOT で、IDE モードの単独タブが対象。
 */
export interface PersistedTerminalTab {
  /** renderer 側 stable id。v1 では `String(numericId)` で number 採番をそのまま文字列化 */
  tabId: string;
  /** Claude / Codex / 素 shell / カスタム engine (`TerminalAgent` と同じ) */
  kind: TerminalAgent;
  /** 起動時に渡した cwd (絶対パス)。symlink 解決はしない (jsonl の cwd と乖離するため) */
  cwd: string;
  /** 最終 PTY size。復元時に `terminal.create({ cols, rows })` の initial seed として渡す */
  cols: number;
  rows: number;
  /** Claude のみ事前注入 UUID。codex / shell は null */
  sessionId: string | null;
  /** ユーザーが手動でリネームしたタブ名。null / 未指定なら自動生成名にフォールバック */
  label?: string | null;
  /** TeamHub に attach していたタブを将来検出するための任意参照 (v1 では検出しない) */
  teamId?: string | null;
  agentId?: string | null;
  role?: string | null;
}

/** 1 プロジェクトの全タブ + アクティブタブ id。 */
export interface PersistedTerminalTabsByProject {
  /** 配列順 = タブの表示順序 */
  tabs: PersistedTerminalTab[];
  /** 最後にアクティブだった tabId (復元時にフォーカスする)。null で先頭タブ採用 */
  activeTabId: string | null;
}

/** terminal-tabs.json のトップレベル形 (atomic write 単位)。 */
export interface PersistedTerminalTabsFile {
  schemaVersion: number;
  /** 最後に save した RFC3339 (debug / orphan 検出用) */
  lastSavedAt: string;
  /**
   * プロジェクトルート毎のタブ集合。raw projectRoot を key にし、検索側で
   * `normalize_project_root` を経由して照合する (`team_history.rs` と同流儀)。
   */
  byProject: Record<string, PersistedTerminalTabsByProject>;
}

// ---------- TeamHub inject failure (Issue #511) ----------

/**
 * Issue #511: PTY inject 失敗の reason を機械的に分岐する用の安定 code 名前空間。
 * Rust 側 `team_hub::inject::InjectError::code()` と完全に一致させる。
 *
 * - `inject_no_session`: 該当 agent_id の PTY session が存在しない (1 byte も書いていない)。安全に retry 可。
 * - `inject_write_initial_failed`: 最初のチャンク write 失敗 (1 byte も書いていない)。安全に retry 可。
 * - `inject_write_partial`: 途中チャンクで write 失敗 (本文の一部が届いている)。retry すると二重 paste になる可能性あり。
 * - `inject_session_replaced`: 注入中に同 agent_id の PTY が別 session に置き換わった (本文の一部が旧 PTY に残った可能性)。
 * - `inject_final_cr_failed`: 全チャンク届いたが末尾 `\r` (送信確定) が失敗。受信側は bracketed-paste 入力欄のまま。
 * - `inject_task_join_failed`: tokio::task::spawn_blocking が join 失敗 (panic 等、稀)。phase により retry 可否が異なる。
 */
export type InjectFailureCode =
  | 'inject_no_session'
  | 'inject_write_initial_failed'
  | 'inject_write_partial'
  | 'inject_session_replaced'
  | 'inject_final_cr_failed'
  | 'inject_task_join_failed';

/**
 * `team:inject_failed` event payload の `reason` フィールド、および `team_send_retry_inject`
 * の戻り値 `reasonCode` / `error` の構造化形。
 */
export interface InjectFailureReason {
  code: InjectFailureCode;
  message: string;
}

/**
 * Rust 側 `app.emit("team:inject_failed", payload)` の payload。
 * Canvas 側 `useTeamInjectFailed` フックがこれを受けて該当 agent の `lastInjectFailure` を更新する。
 */
export interface TeamInjectFailedEvent {
  teamId: string;
  fromAgentId: string;
  fromRole: string;
  toAgentId: string;
  toRole: string;
  messageId: number;
  reasonCode: InjectFailureCode;
  reasonMessage: string;
  failedAt: string;
  /** retry IPC 経由の再失敗かどうか。true なら UI に「retry も失敗」と表示する。 */
  retried?: boolean;
}

/**
 * `window.api.team.retryInject(...)` の引数 (renderer → Rust)。Rust 側 `RetryInjectArgs` と camelCase で一致。
 */
export interface RetryInjectArgs {
  teamId: string;
  /** Hub 側 `TeamMessage.id` (u32 だが TS は number でカバー)。 */
  messageId: number;
  /** 再 inject 対象の agent_id。元 message の resolved_recipient_ids に含まれている必要あり。 */
  agentId: string;
}

/**
 * Rust 側 `RetryInjectResult` の TS 表現。`ok=true` は inject 完了 (delivered_at 入り)、
 * `ok=false` は再失敗 (`reasonCode` / `error` / `failedAt` 入り)。
 */
export interface RetryInjectResult {
  ok: boolean;
  error?: string;
  reasonCode?: InjectFailureCode;
  deliveredAt?: string;
  failedAt?: string;
}

// ---------- TeamHub delivery_status (Issue #509) ----------

/**
 * Issue #509: `team_send` レスポンスに含まれる「PTY に届いたが、まだ recipient が
 * `team_read` を呼んでいない」状態の agent。Leader が「送ったから着手しているはず」
 * と誤解する余地を消すため、`deliveryStatus` (delivered/failed) と並列で正規化済み配列を返す。
 *
 * 60s 経過後も pending のままの場合は `team_diagnostics.pendingInbox*` /
 * `stalledInbound: true` で自動的に督促候補として浮上する設計と組み合わせて使う。
 */
export interface PendingRecipient {
  agentId: string;
  role: string;
  /** RFC3339 配達時刻 (= inject 成功時刻)。 */
  deliveredAt: string;
}

/**
 * Issue #509: `team_send` 時点で既に既読印が付いていた agent。
 * 通常は sender 自身のみ (sender は send 時に self を read_by に push する設計のため)。
 */
export interface ReadSoFarRecipient {
  agentId: string;
  role: string;
  readAt: string;
}

/**
 * Issue #509: Hub が `team_read` 経由で **新しく** 既読印を付けた瞬間に emit する event。
 * Canvas 側 `useTeamInboxRead` フックがこれを受け、対象 agent の unread badge を減算する。
 *
 * 1 回の `team_read` で複数 message を一括既読することがあるため `messageIds` は配列。
 */
export interface TeamInboxReadEvent {
  teamId: string;
  /** 今回新たに既読化された message id の配列 (既読再呼び出しの場合は空 → event は emit されない)。 */
  messageIds: number[];
  readByAgentId: string;
  readByRole: string;
  /** RFC3339 既読時刻 (= team_read を呼んだ時刻)。 */
  readAt: string;
}

// ---------- TeamHub diagnostics staleness (Issue #524) ----------

/**
 * Issue #524: `team_diagnostics` MCP tool の `members[i]` row 形 (camelCase JSON)。
 * Leader / HR が member の活動状況・自己申告と物理シグナル (PTY 出力) の乖離を判定する。
 *
 * `team_diagnostics` 自体は MCP tool で agent process が呼ぶ形 (renderer 側 IPC ではない)
 * だが、将来 Canvas Dashboard (#514) で Tauri IPC 経由でも露出するため、型の正本としてここに置く。
 * 既存フィールドは Issue #409 (`currentStatus` / `lastStatusAt`) と Issue #511 / #509 で
 * 整備した `pendingInbox*` / `stalledInbound` を踏襲。
 */
export interface TeamDiagnosticsMemberRow {
  agentId: string;
  role: string;
  online: boolean;
  inconsistent: boolean;
  recruitedAt: string;
  lastHandshakeAt: string | null;
  lastSeenAt: string | null;
  lastAgentActivityAt: string | null;
  lastMessageInAt: string | null;
  lastMessageOutAt: string | null;
  messagesInCount: number;
  messagesOutCount: number;
  tasksClaimedCount: number;
  pendingInbox: number[];
  pendingInboxCount: number;
  oldestPendingInboxAgeMs: number | null;
  stalledInbound: boolean;
  /** Issue #409: `team_status(status)` で agent が自己申告した最新ステータス文字列。 */
  currentStatus: string | null;
  /** Issue #409: `currentStatus` を更新した最終時刻 (RFC3339)。 */
  lastStatusAt: string | null;
  /**
   * Issue #524: PTY から最後に出力 byte が流れた時刻 (RFC3339)。
   * agent process がハングしているか / 動いているかの物理シグナル。
   * batcher 側で 1 秒間隔の dedup を経て update されるので、`null` のまま長時間 (分単位)
   * 続いた場合は実際にプロセスが動いていない可能性が高い。
   */
  lastPtyOutputAt: string | null;
  /** `lastStatusAt` から現在までの経過 ms (`null` なら一度も自己申告がない)。 */
  lastStatusAgeMs: number | null;
  /** `lastPtyOutputAt` から現在までの経過 ms (`null` なら一度も PTY 出力が観測されていない)。 */
  lastPtyActivityAgeMs: number | null;
  /**
   * 自動 stale 判定: 自己申告が古く / 無く、かつ PTY 出力も threshold を超過 (or 無い) ならば true。
   * PTY が直近に活動している場合は「動いている」ので false (= 誤検知防止)。
   * Leader / Canvas dashboard の警告バッジに使う。
   */
  autoStale: boolean;
  /** `autoStale` の閾値 (ms)。Hub 側の `STATUS_STALE_THRESHOLD_SECS` を ms 換算したもの。 */
  stalenessThresholdMs: number;
}

// ---------- Canvas Visibility Observation (Issue #578) ----------

/**
 * Issue #578: Canvas が非表示中 (`document.visibilityState === 'hidden'` または
 * Tauri Window がフォーカス外) に `team:recruit-request` が走った観測を Hub 側へ
 * 通知するための IPC 引数。`hiddenForMs >= 5000` の場合のみ renderer から呼ばれる。
 *
 * Rust 側は `tracing::info!` でサーバログに 1 行残すだけの軽量 endpoint。
 * Leader / 開発者がログ集計で「非アクティブ中採用の頻度」を見るための観測点。
 */
export interface RecruitObservedWhileHiddenArgs {
  teamId: string;
  /** 採用された新規 agent_id (recruit-request payload の newAgentId)。 */
  agentId: string;
  /** Canvas が hidden だった経過時間 (ms)。 */
  hiddenForMs: number;
}

/**
 * Issue #577: ack timeout 後の grace 期間中に遅着 ack が救済された通知。
 * Rust 側 `RecruitRescuedPayload` (`serde(rename_all = "camelCase")`) と整合。
 */
export interface RecruitRescuedPayload {
  /** 採用された新規 agent_id (recruit-request payload の newAgentId)。 */
  newAgentId: string;
  /** timeout から ack 遅着までの経過時間 (ms)。 */
  lateByMs: number;
}

// ---------- Window Effects (Issue #260) ----------

/**
 * Issue #260 PR-1: テーマ別の OS ネイティブ window effect 適用結果。
 * - Windows: Acrylic (PowerShell 同等の動的ぼかし)
 * - macOS: vibrancy (under-window)
 * - Linux: 非対応 (no-op、`applied=false` で返る)
 */
export interface SetWindowEffectsResult {
  ok: boolean;
  /**
   * OS ネイティブ effect が実際に適用されたか。Linux 等の非対応プラットフォームや
   * Windows 10 21H2 以前では false。renderer 側はこれを見て CSS backdrop-filter
   * フォールバックの有無を判断する余地を持つ (現時点では CSS 側で常に効いている)。
   */
  applied: boolean;
  error?: string;
}

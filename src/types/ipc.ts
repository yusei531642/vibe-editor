/**
 * ipc.ts — IPC チャンネル名と input/output 型を 1 ファイルに集約。
 *
 * Tauri 側の tauri::command と renderer 側 (lib/tauri-api.ts 経由) の双方から
 * 参照する、IPC 契約の単一情報源 (SSOT)。
 *
 * ルール:
 * - チャンネル名は `<namespace>:<action>` のコロン区切り (旧 Electron 時代の命名を継承)
 * - Rust 側の #[tauri::command] 関数名は `<namespace>_<action>` (scripts で機械変換可能)
 * - 構造が複雑な input/output は src/types/shared.ts の既存型を参照する
 */

import type {
  AppSettings,
  AppUserInfo,
  ClaudeCheckResult,
  FileListResult,
  FileReadResult,
  FileWriteResult,
  GitDiffResult,
  GitStatus,
  SessionInfo,
  TeamHistoryEntry,
  TerminalCreateOptions,
  TerminalCreateResult
} from './shared';

// ---------- チャンネル名定数 ----------

export const IPC_CHANNELS = {
  PING: 'ping',

  // app
  APP_GET_PROJECT_ROOT: 'app:getProjectRoot',
  APP_RESTART: 'app:restart',
  APP_SET_WINDOW_TITLE: 'app:setWindowTitle',
  APP_CHECK_CLAUDE: 'app:checkClaude',
  APP_SET_ZOOM_LEVEL: 'app:setZoomLevel',
  APP_GET_ZOOM_LEVEL: 'app:getZoomLevel',
  APP_SETUP_TEAM_MCP: 'app:setupTeamMcp',
  APP_CLEANUP_TEAM_MCP: 'app:cleanupTeamMcp',
  APP_GET_TEAM_FILE_PATH: 'app:getTeamFilePath',
  APP_GET_MCP_SERVER_PATH: 'app:getMcpServerPath',
  APP_GET_TEAM_HUB_INFO: 'app:getTeamHubInfo',
  APP_GET_USER_INFO: 'app:getUserInfo',
  APP_OPEN_EXTERNAL: 'app:openExternal',

  // git
  GIT_STATUS: 'git:status',
  GIT_DIFF: 'git:diff',

  // files
  FILES_LIST: 'files:list',
  FILES_READ: 'files:read',
  FILES_WRITE: 'files:write',

  // sessions
  SESSIONS_LIST: 'sessions:list',

  // team history
  TEAM_HISTORY_LIST: 'teamHistory:list',
  TEAM_HISTORY_SAVE: 'teamHistory:save',
  TEAM_HISTORY_DELETE: 'teamHistory:delete',

  // dialog
  DIALOG_OPEN_FOLDER: 'dialog:openFolder',
  DIALOG_OPEN_FILE: 'dialog:openFile',
  DIALOG_IS_FOLDER_EMPTY: 'dialog:isFolderEmpty',

  // settings
  SETTINGS_LOAD: 'settings:load',
  SETTINGS_SAVE: 'settings:save',

  // terminal
  TERMINAL_CREATE: 'terminal:create',
  TERMINAL_WRITE: 'terminal:write',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_KILL: 'terminal:kill',
  TERMINAL_SAVE_PASTED_IMAGE: 'terminal:savePastedImage'
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

// ---------- 動的に id で分岐するイベントチャンネル ----------

/** pty の stdout を flush するチャンネル。 id は session id (UUID)。 */
export const terminalDataChannel = (id: string): string => `terminal:data:${id}`;
/** pty の exit 通知チャンネル。 */
export const terminalExitChannel = (id: string): string => `terminal:exit:${id}`;
/** Claude Code のセッション UUID 検出通知チャンネル。 */
export const terminalSessionIdChannel = (id: string): string => `terminal:sessionId:${id}`;

// ---------- 共通戻り値型 ----------

export interface OpenExternalResult {
  ok: boolean;
  error?: string;
}

export interface SetupTeamMcpResult {
  ok: boolean;
  error?: string;
  socket?: string;
  changed?: boolean;
}

export interface CleanupTeamMcpResult {
  ok: boolean;
  error?: string;
  removed?: boolean;
}

export interface TeamHubInfo {
  socket: string;
  token: string;
  bridgePath: string;
}

export interface SavePastedImageResult {
  ok: boolean;
  path?: string;
  error?: string;
}

export interface MutationResult {
  ok: boolean;
  error?: string;
}

export interface TeamMcpMember {
  agentId: string;
  role: string;
  agent: string;
}

// ---------- チャンネル → 型マッピング ----------

/**
 * `IpcMap[channel]` で request / response の型が引ける。
 * `request` はタプル (可変引数) 形式で、引数の個数と順序が保たれる。
 */
export interface IpcMap {
  // ping
  [IPC_CHANNELS.PING]: { request: []; response: string };

  // app
  [IPC_CHANNELS.APP_GET_PROJECT_ROOT]: { request: []; response: string };
  [IPC_CHANNELS.APP_RESTART]: { request: []; response: void };
  [IPC_CHANNELS.APP_SET_WINDOW_TITLE]: { request: [title: string]; response: void };
  [IPC_CHANNELS.APP_CHECK_CLAUDE]: {
    request: [command: string];
    response: ClaudeCheckResult;
  };
  [IPC_CHANNELS.APP_SET_ZOOM_LEVEL]: { request: [level: number]; response: void };
  [IPC_CHANNELS.APP_GET_ZOOM_LEVEL]: { request: []; response: number };
  [IPC_CHANNELS.APP_SETUP_TEAM_MCP]: {
    request: [
      projectRoot: string,
      teamId: string,
      teamName: string,
      members: TeamMcpMember[]
    ];
    response: SetupTeamMcpResult;
  };
  [IPC_CHANNELS.APP_CLEANUP_TEAM_MCP]: {
    request: [projectRoot: string, teamId: string];
    response: CleanupTeamMcpResult;
  };
  [IPC_CHANNELS.APP_GET_TEAM_FILE_PATH]: {
    request: [teamId: string];
    response: string;
  };
  [IPC_CHANNELS.APP_GET_MCP_SERVER_PATH]: { request: []; response: string };
  [IPC_CHANNELS.APP_GET_TEAM_HUB_INFO]: { request: []; response: TeamHubInfo };
  [IPC_CHANNELS.APP_GET_USER_INFO]: { request: []; response: AppUserInfo };
  [IPC_CHANNELS.APP_OPEN_EXTERNAL]: {
    request: [url: string];
    response: OpenExternalResult;
  };

  // git
  [IPC_CHANNELS.GIT_STATUS]: {
    request: [projectRoot: string];
    response: GitStatus;
  };
  [IPC_CHANNELS.GIT_DIFF]: {
    request: [projectRoot: string, relPath: string];
    response: GitDiffResult;
  };

  // files
  [IPC_CHANNELS.FILES_LIST]: {
    request: [projectRoot: string, relPath: string];
    response: FileListResult;
  };
  [IPC_CHANNELS.FILES_READ]: {
    request: [projectRoot: string, relPath: string];
    response: FileReadResult;
  };
  [IPC_CHANNELS.FILES_WRITE]: {
    request: [projectRoot: string, relPath: string, content: string];
    response: FileWriteResult;
  };

  // sessions
  [IPC_CHANNELS.SESSIONS_LIST]: {
    request: [projectRoot: string];
    response: SessionInfo[];
  };

  // team history
  [IPC_CHANNELS.TEAM_HISTORY_LIST]: {
    request: [projectRoot: string];
    response: TeamHistoryEntry[];
  };
  [IPC_CHANNELS.TEAM_HISTORY_SAVE]: {
    request: [entry: TeamHistoryEntry];
    response: MutationResult;
  };
  [IPC_CHANNELS.TEAM_HISTORY_DELETE]: {
    request: [id: string];
    response: MutationResult;
  };

  // dialog
  [IPC_CHANNELS.DIALOG_OPEN_FOLDER]: {
    request: [title?: string];
    response: string | null;
  };
  [IPC_CHANNELS.DIALOG_OPEN_FILE]: {
    request: [title?: string];
    response: string | null;
  };
  [IPC_CHANNELS.DIALOG_IS_FOLDER_EMPTY]: {
    request: [folderPath: string];
    response: boolean;
  };

  // settings
  [IPC_CHANNELS.SETTINGS_LOAD]: { request: []; response: AppSettings };
  [IPC_CHANNELS.SETTINGS_SAVE]: {
    request: [settings: AppSettings];
    response: void;
  };

  // terminal
  [IPC_CHANNELS.TERMINAL_CREATE]: {
    request: [opts: TerminalCreateOptions];
    response: TerminalCreateResult;
  };
  [IPC_CHANNELS.TERMINAL_WRITE]: {
    request: [id: string, data: string];
    response: void;
  };
  [IPC_CHANNELS.TERMINAL_RESIZE]: {
    request: [id: string, cols: number, rows: number];
    response: void;
  };
  [IPC_CHANNELS.TERMINAL_KILL]: { request: [id: string]; response: void };
  [IPC_CHANNELS.TERMINAL_SAVE_PASTED_IMAGE]: {
    request: [base64: string, mimeType: string];
    response: SavePastedImageResult;
  };
}

export type IpcRequest<K extends keyof IpcMap> = IpcMap[K]['request'];
export type IpcResponse<K extends keyof IpcMap> = IpcMap[K]['response'];

/**
 * tauri-api.ts — renderer 向け IPC 互換層
 *
 * 役割:
 * - `import { api } from './tauri-api'` で namespaced な API を提供
 * - 内部では `@tauri-apps/api/core` の `invoke()` と `listen()` を呼ぶ
 * - `window.api` にも同じインスタンスを割り当てている (旧コードパスとの互換のため)
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/**
 * `listen()` は Promise で unlisten を返すが、caller が cleanup を同期的に要求することが多い。
 * naive に `listen().then(u => unlisten = u)` すると Promise resolve 前に呼ばれた cleanup が no-op
 * になり、listener が orphan 化する。
 *
 * この helper は cleanup 要求を sentinel (`disposed`) で記録し、listen() 解決時に deferred
 * unlisten を行う。したがって:
 *   - 早期 cleanup: resolve 時に即 u() を呼び、永続 listener を残さない
 *   - 通常 cleanup: unlisten を保持し、呼び出し時に u() を実行
 */
function subscribeEvent<T>(event: string, cb: (payload: T) => void): () => void {
  let unlisten: UnlistenFn | null = null;
  let disposed = false;
  void listen<T>(event, (e) => {
    if (!disposed) cb(e.payload);
  }).then((u) => {
    if (disposed) {
      u();
    } else {
      unlisten = u;
    }
  });
  return () => {
    disposed = true;
    unlisten?.();
    unlisten = null;
  };
}
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type AppUserInfo,
  type ClaudeCheckResult,
  type FileListResult,
  type FileReadResult,
  type FileWriteResult,
  type GitDiffResult,
  type GitStatus,
  type SessionInfo,
  type TeamHistoryEntry,
  type TerminalCreateOptions,
  type TerminalCreateResult,
  type TerminalExitInfo
} from '../../../types/shared';

interface TeamMcpMember {
  agentId: string;
  role: string;
  agent: string;
}
interface SetupTeamMcpResult {
  ok: boolean;
  error?: string;
  socket?: string;
  changed?: boolean;
}
interface CleanupTeamMcpResult {
  ok: boolean;
  error?: string;
  removed?: boolean;
}
interface OpenExternalResult {
  ok: boolean;
  error?: string;
}
interface TeamHubInfo {
  socket: string;
  token: string;
  bridgePath: string;
}
interface SavePastedImageResult {
  ok: boolean;
  path?: string;
  error?: string;
}
interface MutationResult {
  ok: boolean;
  error?: string;
}

export const api = {
  ping: (): Promise<string> => invoke('ping'),

  app: {
    getProjectRoot: (): Promise<string> => invoke('app_get_project_root'),
    restart: (): Promise<void> => invoke('app_restart'),
    setWindowTitle: (title: string): Promise<void> => invoke('app_set_window_title', { title }),
    checkClaude: (command: string): Promise<ClaudeCheckResult> =>
      invoke('app_check_claude', { command }),
    setZoomLevel: (level: number): Promise<void> => invoke('app_set_zoom_level', { level }),
    getZoomLevel: (): Promise<number> => invoke('app_get_zoom_level'),
    setupTeamMcp: (
      projectRoot: string,
      teamId: string,
      teamName: string,
      members: TeamMcpMember[]
    ): Promise<SetupTeamMcpResult> =>
      invoke('app_setup_team_mcp', { projectRoot, teamId, teamName, members }),
    cleanupTeamMcp: (projectRoot: string, teamId: string): Promise<CleanupTeamMcpResult> =>
      invoke('app_cleanup_team_mcp', { projectRoot, teamId }),
    getTeamFilePath: (teamId: string): Promise<string> =>
      invoke('app_get_team_file_path', { teamId }),
    getMcpServerPath: (): Promise<string> => invoke('app_get_mcp_server_path'),
    getTeamHubInfo: (): Promise<TeamHubInfo> => invoke('app_get_team_hub_info'),
    getUserInfo: (): Promise<AppUserInfo> => invoke('app_get_user_info'),
    openExternal: (url: string): Promise<OpenExternalResult> => invoke('app_open_external', { url })
  },

  git: {
    status: (projectRoot: string): Promise<GitStatus> => invoke('git_status', { projectRoot }),
    diff: (
      projectRoot: string,
      relPath: string,
      originalRelPath?: string
    ): Promise<GitDiffResult> =>
      invoke('git_diff', { projectRoot, relPath, originalRelPath })
  },

  files: {
    list: (projectRoot: string, relPath: string): Promise<FileListResult> =>
      invoke('files_list', { projectRoot, relPath }),
    read: (projectRoot: string, relPath: string): Promise<FileReadResult> =>
      invoke('files_read', { projectRoot, relPath }),
    write: (projectRoot: string, relPath: string, content: string): Promise<FileWriteResult> =>
      invoke('files_write', { projectRoot, relPath, content })
  },

  sessions: {
    list: (projectRoot: string): Promise<SessionInfo[]> =>
      invoke('sessions_list', { projectRoot })
  },

  teamHistory: {
    list: (projectRoot: string): Promise<TeamHistoryEntry[]> =>
      invoke('team_history_list', { projectRoot }),
    save: (entry: TeamHistoryEntry): Promise<MutationResult> =>
      invoke('team_history_save', { entry }),
    delete: (id: string): Promise<MutationResult> => invoke('team_history_delete', { id })
  },

  dialog: {
    openFolder: (title?: string): Promise<string | null> =>
      invoke('dialog_open_folder', { title }),
    openFile: (title?: string): Promise<string | null> => invoke('dialog_open_file', { title }),
    isFolderEmpty: (folderPath: string): Promise<boolean> =>
      invoke('dialog_is_folder_empty', { folderPath })
  },

  settings: {
    load: async (): Promise<AppSettings> => {
      // Rust 側は未保存の場合 null を返す。null は React 側で扱えないため
      // DEFAULT_SETTINGS にフォールバック + 部分マージで欠損キーを補完。
      const raw = await invoke<Partial<AppSettings> | null>('settings_load');
      return { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
    },
    save: (settings: AppSettings): Promise<void> => invoke('settings_save', { settings })
  },

  terminal: {
    create: (opts: TerminalCreateOptions): Promise<TerminalCreateResult> =>
      invoke('terminal_create', { opts }),
    write: (id: string, data: string): Promise<void> =>
      invoke('terminal_write', { id, data }),
    resize: (id: string, cols: number, rows: number): Promise<void> =>
      invoke('terminal_resize', { id, cols, rows }),
    kill: (id: string): Promise<void> => invoke('terminal_kill', { id }),
    savePastedImage: (base64: string, mimeType: string): Promise<SavePastedImageResult> =>
      invoke('terminal_save_pasted_image', { base64, mimeType }),

    onData: (id: string, cb: (data: string) => void): (() => void) =>
      subscribeEvent<string>(`terminal:data:${id}`, cb),

    onExit: (id: string, cb: (info: TerminalExitInfo) => void): (() => void) =>
      subscribeEvent<TerminalExitInfo>(`terminal:exit:${id}`, cb),

    onSessionId: (id: string, cb: (sessionId: string) => void): (() => void) =>
      subscribeEvent<string>(`terminal:sessionId:${id}`, cb)
  }
};

export type Api = typeof api;

/**
 * Tauri 環境かどうかを判定。renderer 側で Electron / Tauri の自動切り替え用。
 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// ---------- 自動 bootstrap ----------
// 環境を問わず window.api が未注入なら Tauri 版シムを設定する。
// 動作保証:
//   - Electron: preload が module 評価前に window.api を注入 → if 文を skip
//   - Tauri:    preload なし → ここで window.api = api を設定
//   - 通常ブラウザ (vite dev 直接アクセス): window.api が存在しないので shim 設定。
//     Tauri 内部 invoke 呼び出しは失敗するが、最低限 React の mount は通る。
if (typeof window !== 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  if (!w.api) {
    w.api = api;
    console.info(
      '[tauri-api] window.api を Tauri shim にバインド (isTauri=' + isTauri() + ')'
    );
  }
}

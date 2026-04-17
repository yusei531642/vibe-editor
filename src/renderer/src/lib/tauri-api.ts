/**
 * tauri-api.ts — Electron `window.api` 互換層
 *
 * 役割:
 * - Phase 1 Tauri 移行で renderer 側のコード変更を最小化するための互換シム
 * - `import { api } from './tauri-api'` で Electron 版 `window.api` と同じ shape を提供
 * - 内部的には `@tauri-apps/api/core` の `invoke()` を呼ぶ
 *
 * 既存 Electron 版 (`src/preload/index.ts`) との切り替え:
 *   import { api } from './lib/tauri-api'   // Tauri 版
 *   const api = window.api                  // Electron 版
 *
 * Phase 1 完了時に renderer 全体の import を Tauri 版に切り替え。
 * Electron 版 preload は当面残す (デュアル運用)。
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
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
    diff: (projectRoot: string, relPath: string): Promise<GitDiffResult> =>
      invoke('git_diff', { projectRoot, relPath })
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

    onData: (id: string, cb: (data: string) => void): (() => void) => {
      let unlisten: UnlistenFn | null = null;
      void listen<string>(`terminal:data:${id}`, (e) => cb(e.payload)).then((u) => {
        unlisten = u;
      });
      return () => {
        unlisten?.();
      };
    },

    onExit: (id: string, cb: (info: TerminalExitInfo) => void): (() => void) => {
      let unlisten: UnlistenFn | null = null;
      void listen<TerminalExitInfo>(`terminal:exit:${id}`, (e) => cb(e.payload)).then((u) => {
        unlisten = u;
      });
      return () => {
        unlisten?.();
      };
    },

    onSessionId: (id: string, cb: (sessionId: string) => void): (() => void) => {
      let unlisten: UnlistenFn | null = null;
      void listen<string>(`terminal:sessionId:${id}`, (e) => cb(e.payload)).then((u) => {
        unlisten = u;
      });
      return () => {
        unlisten?.();
      };
    }
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

import { contextBridge, ipcRenderer } from 'electron';
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
  TerminalCreateResult,
  TerminalExitInfo
} from '../types/shared';
import {
  IPC_CHANNELS,
  terminalDataChannel,
  terminalExitChannel,
  terminalSessionIdChannel,
  type TeamMcpMember,
  type SetupTeamMcpResult,
  type CleanupTeamMcpResult,
  type OpenExternalResult,
  type TeamHubInfo,
  type SavePastedImageResult,
  type MutationResult
} from '../types/ipc';

const api = {
  ping: (): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.PING),

  app: {
    getProjectRoot: (): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_PROJECT_ROOT),
    restart: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.APP_RESTART),
    setWindowTitle: (title: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_SET_WINDOW_TITLE, title),
    checkClaude: (command: string): Promise<ClaudeCheckResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_CHECK_CLAUDE, command),
    setZoomLevel: (level: number): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_SET_ZOOM_LEVEL, level),
    getZoomLevel: (): Promise<number> => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_ZOOM_LEVEL),
    setupTeamMcp: (
      projectRoot: string,
      teamId: string,
      teamName: string,
      members: TeamMcpMember[]
    ): Promise<SetupTeamMcpResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_SETUP_TEAM_MCP, projectRoot, teamId, teamName, members),
    cleanupTeamMcp: (projectRoot: string, teamId: string): Promise<CleanupTeamMcpResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_CLEANUP_TEAM_MCP, projectRoot, teamId),
    getTeamFilePath: (teamId: string): Promise<string> =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_GET_TEAM_FILE_PATH, teamId),
    getMcpServerPath: (): Promise<string> =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_GET_MCP_SERVER_PATH),
    getTeamHubInfo: (): Promise<TeamHubInfo> =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_GET_TEAM_HUB_INFO),
    getUserInfo: (): Promise<AppUserInfo> => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_USER_INFO),
    openExternal: (url: string): Promise<OpenExternalResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_OPEN_EXTERNAL, url)
  },

  git: {
    status: (projectRoot: string): Promise<GitStatus> =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_STATUS, projectRoot),
    diff: (projectRoot: string, relPath: string): Promise<GitDiffResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_DIFF, projectRoot, relPath)
  },

  files: {
    list: (projectRoot: string, relPath: string): Promise<FileListResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILES_LIST, projectRoot, relPath),
    read: (projectRoot: string, relPath: string): Promise<FileReadResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILES_READ, projectRoot, relPath),
    write: (projectRoot: string, relPath: string, content: string): Promise<FileWriteResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILES_WRITE, projectRoot, relPath, content)
  },

  sessions: {
    list: (projectRoot: string): Promise<SessionInfo[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSIONS_LIST, projectRoot)
  },

  teamHistory: {
    list: (projectRoot: string): Promise<TeamHistoryEntry[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.TEAM_HISTORY_LIST, projectRoot),
    save: (entry: TeamHistoryEntry): Promise<MutationResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.TEAM_HISTORY_SAVE, entry),
    delete: (id: string): Promise<MutationResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.TEAM_HISTORY_DELETE, id)
  },

  dialog: {
    openFolder: (title?: string): Promise<string | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.DIALOG_OPEN_FOLDER, title),
    openFile: (title?: string): Promise<string | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.DIALOG_OPEN_FILE, title),
    isFolderEmpty: (folderPath: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.DIALOG_IS_FOLDER_EMPTY, folderPath)
  },

  settings: {
    load: (): Promise<AppSettings> => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_LOAD),
    save: (settings: AppSettings): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SAVE, settings)
  },

  terminal: {
    create: (opts: TerminalCreateOptions): Promise<TerminalCreateResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_CREATE, opts),
    write: (id: string, data: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_WRITE, id, data),
    resize: (id: string, cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_RESIZE, id, cols, rows),
    kill: (id: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_KILL, id),
    savePastedImage: (base64: string, mimeType: string): Promise<SavePastedImageResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_SAVE_PASTED_IMAGE, base64, mimeType),

    onData: (id: string, cb: (data: string) => void): (() => void) => {
      const ch = terminalDataChannel(id);
      const listener = (_e: Electron.IpcRendererEvent, data: string): void => cb(data);
      ipcRenderer.on(ch, listener);
      return () => ipcRenderer.off(ch, listener);
    },

    onExit: (id: string, cb: (info: TerminalExitInfo) => void): (() => void) => {
      const ch = terminalExitChannel(id);
      const listener = (_e: Electron.IpcRendererEvent, info: TerminalExitInfo): void => cb(info);
      ipcRenderer.on(ch, listener);
      return () => ipcRenderer.off(ch, listener);
    },

    onSessionId: (id: string, cb: (sessionId: string) => void): (() => void) => {
      const ch = terminalSessionIdChannel(id);
      const listener = (_e: Electron.IpcRendererEvent, sessionId: string): void => cb(sessionId);
      ipcRenderer.on(ch, listener);
      return () => ipcRenderer.off(ch, listener);
    }
  }
};

try {
  contextBridge.exposeInMainWorld('api', api);
} catch (error) {
  console.error('[preload] contextBridge.exposeInMainWorld に失敗:', error);
}

export type Api = typeof api;

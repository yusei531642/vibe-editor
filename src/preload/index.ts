import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppSettings,
  ClaudeCheckResult,
  FileListResult,
  FileReadResult,
  FileWriteResult,
  GitDiffResult,
  GitStatus,
  SessionInfo,
  TerminalCreateOptions,
  TerminalCreateResult,
  TerminalExitInfo
} from '../types/shared';

const api = {
  ping: (): Promise<string> => ipcRenderer.invoke('ping'),

  app: {
    getProjectRoot: (): Promise<string> => ipcRenderer.invoke('app:getProjectRoot'),
    restart: (): Promise<void> => ipcRenderer.invoke('app:restart'),
    setWindowTitle: (title: string): Promise<void> =>
      ipcRenderer.invoke('app:setWindowTitle', title),
    checkClaude: (command: string): Promise<ClaudeCheckResult> =>
      ipcRenderer.invoke('app:checkClaude', command),
    setZoomLevel: (level: number): Promise<void> =>
      ipcRenderer.invoke('app:setZoomLevel', level),
    getZoomLevel: (): Promise<number> =>
      ipcRenderer.invoke('app:getZoomLevel'),
    setupTeamMcp: (
      projectRoot: string,
      teamId: string,
      teamName: string,
      members: { agentId: string; role: string; agent: string }[]
    ): Promise<{ ok: boolean; socket?: string; error?: string; changed?: boolean }> =>
      ipcRenderer.invoke('app:setupTeamMcp', projectRoot, teamId, teamName, members),
    cleanupTeamMcp: (
      projectRoot: string,
      teamId: string
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('app:cleanupTeamMcp', projectRoot, teamId),
    getTeamFilePath: (teamId: string): Promise<string> =>
      ipcRenderer.invoke('app:getTeamFilePath', teamId),
    getMcpServerPath: (): Promise<string> =>
      ipcRenderer.invoke('app:getMcpServerPath'),
    getTeamHubInfo: (): Promise<{ socket: string; token: string; bridgePath: string }> =>
      ipcRenderer.invoke('app:getTeamHubInfo')
  },

  git: {
    status: (projectRoot: string): Promise<GitStatus> =>
      ipcRenderer.invoke('git:status', projectRoot),
    diff: (projectRoot: string, relPath: string): Promise<GitDiffResult> =>
      ipcRenderer.invoke('git:diff', projectRoot, relPath)
  },

  files: {
    list: (projectRoot: string, relPath: string): Promise<FileListResult> =>
      ipcRenderer.invoke('files:list', projectRoot, relPath),
    read: (projectRoot: string, relPath: string): Promise<FileReadResult> =>
      ipcRenderer.invoke('files:read', projectRoot, relPath),
    write: (
      projectRoot: string,
      relPath: string,
      content: string
    ): Promise<FileWriteResult> =>
      ipcRenderer.invoke('files:write', projectRoot, relPath, content)
  },

  sessions: {
    list: (projectRoot: string): Promise<SessionInfo[]> =>
      ipcRenderer.invoke('sessions:list', projectRoot)
  },

  dialog: {
    openFolder: (title?: string): Promise<string | null> =>
      ipcRenderer.invoke('dialog:openFolder', title),
    openFile: (title?: string): Promise<string | null> =>
      ipcRenderer.invoke('dialog:openFile', title),
    isFolderEmpty: (folderPath: string): Promise<boolean> =>
      ipcRenderer.invoke('dialog:isFolderEmpty', folderPath)
  },

  settings: {
    load: (): Promise<AppSettings> => ipcRenderer.invoke('settings:load'),
    save: (settings: AppSettings): Promise<void> =>
      ipcRenderer.invoke('settings:save', settings)
  },

  terminal: {
    create: (opts: TerminalCreateOptions): Promise<TerminalCreateResult> =>
      ipcRenderer.invoke('terminal:create', opts),
    write: (id: string, data: string): Promise<void> =>
      ipcRenderer.invoke('terminal:write', id, data),
    resize: (id: string, cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke('terminal:resize', id, cols, rows),
    kill: (id: string): Promise<void> => ipcRenderer.invoke('terminal:kill', id),
    savePastedImage: (
      base64: string,
      mimeType: string
    ): Promise<{ ok: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke('terminal:savePastedImage', base64, mimeType),

    onData: (id: string, cb: (data: string) => void): (() => void) => {
      const ch = `terminal:data:${id}`;
      const listener = (_e: Electron.IpcRendererEvent, data: string): void => cb(data);
      ipcRenderer.on(ch, listener);
      return () => ipcRenderer.off(ch, listener);
    },

    onExit: (id: string, cb: (info: TerminalExitInfo) => void): (() => void) => {
      const ch = `terminal:exit:${id}`;
      const listener = (_e: Electron.IpcRendererEvent, info: TerminalExitInfo): void =>
        cb(info);
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

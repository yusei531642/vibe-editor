import type {
  AppSettings,
  ClaudeCheckResult,
  GitDiffResult,
  GitStatus,
  SessionInfo,
  TerminalCreateOptions,
  TerminalCreateResult,
  TerminalExitInfo
} from './shared';

export {};

declare global {
  interface Window {
    api: {
      ping(): Promise<string>;
      app: {
        getProjectRoot(): Promise<string>;
        restart(): Promise<void>;
        setWindowTitle(title: string): Promise<void>;
        checkClaude(command: string): Promise<ClaudeCheckResult>;
        setZoomLevel(level: number): Promise<void>;
        getZoomLevel(): Promise<number>;
        setupTeamMcp(
          projectRoot: string,
          teamId: string,
          teamName: string,
          members: { agentId: string; role: string; agent: string }[]
        ): Promise<{ ok: boolean; teamFile?: string; error?: string }>;
        cleanupTeamMcp(projectRoot: string, teamId: string): Promise<{ ok: boolean; error?: string }>;
        getTeamFilePath(teamId: string): Promise<string>;
        getMcpServerPath(): Promise<string>;
      };
      git: {
        status(projectRoot: string): Promise<GitStatus>;
        diff(projectRoot: string, relPath: string): Promise<GitDiffResult>;
      };
      sessions: {
        list(projectRoot: string): Promise<SessionInfo[]>;
      };
      dialog: {
        openFolder(title?: string): Promise<string | null>;
        openFile(title?: string): Promise<string | null>;
        isFolderEmpty(folderPath: string): Promise<boolean>;
      };
      settings: {
        load(): Promise<AppSettings>;
        save(settings: AppSettings): Promise<void>;
      };
      terminal: {
        create(opts: TerminalCreateOptions): Promise<TerminalCreateResult>;
        write(id: string, data: string): Promise<void>;
        resize(id: string, cols: number, rows: number): Promise<void>;
        kill(id: string): Promise<void>;
        savePastedImage(
          base64: string,
          mimeType: string
        ): Promise<{ ok: boolean; path?: string; error?: string }>;
        onData(id: string, cb: (data: string) => void): () => void;
        onExit(id: string, cb: (info: TerminalExitInfo) => void): () => void;
      };
    };
  }
}

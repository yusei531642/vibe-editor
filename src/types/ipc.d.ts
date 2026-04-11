// renderer 側で window.api を型安全に利用するためのグローバル宣言
import type {
  AppSettings,
  ClaudeMdFile,
  GitDiffResult,
  GitStatus,
  SaveResult,
  SessionInfo,
  SkillInfo,
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
      };
      claudeMd: {
        find(projectRoot: string): Promise<ClaudeMdFile>;
        save(filePath: string, content: string): Promise<SaveResult>;
      };
      skills: {
        list(projectRoot: string): Promise<SkillInfo[]>;
      };
      sessions: {
        list(projectRoot: string): Promise<SessionInfo[]>;
      };
      dialog: {
        openFolder(title?: string): Promise<string | null>;
        openFile(title?: string): Promise<string | null>;
        isFolderEmpty(folderPath: string): Promise<boolean>;
      };
      git: {
        status(projectRoot: string): Promise<GitStatus>;
        diff(projectRoot: string, relPath: string): Promise<GitDiffResult>;
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
        onData(id: string, cb: (data: string) => void): () => void;
        onExit(id: string, cb: (info: TerminalExitInfo) => void): () => void;
      };
    };
  }
}

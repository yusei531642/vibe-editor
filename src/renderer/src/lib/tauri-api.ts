/**
 * tauri-api.ts — renderer 向け IPC 互換層
 *
 * 役割:
 * - `import { api } from './tauri-api'` で namespaced な API を提供
 * - 内部では `@tauri-apps/api/core` の `invoke()` と `listen()` を呼ぶ
 * - `window.api` にも同じインスタンスを割り当てている (旧コードパスとの互換のため)
 */

import { invoke } from '@tauri-apps/api/core';
import { subscribeEvent, subscribeEventReady } from './subscribe-event';
import {
  type AppSettings,
  type AppUserInfo,
  type ClaudeCheckResult,
  type FileListResult,
  type FileReadResult,
  type FileWriteResult,
  type GitDiffResult,
  type GitStatus,
  type RoleProfilesFile,
  type SessionInfo,
  type SetWindowEffectsResult,
  type TeamHistoryEntry,
  type TerminalCreateOptions,
  type TerminalCreateResult,
  type TerminalExitInfo,
  type ThemeName
} from '../../../types/shared';

// Issue #294: `subscribeEvent` / `subscribeEventReady` は `./subscribe-event.ts` に
// 切り出し、`subscribeEvent` は `subscribeEventReady` の sync ラッパとして再実装。
// これにより「await 解決前後の disposed sentinel」のロジックが 1 箇所に集約され、
// Issue #285 と同型の post-subscribe race を構造的に再生産しないことを保証する。

/** Tauri 側 TeamHub に同期する role profile の要約形 */
export interface RoleProfileSummary {
  id: string;
  labelEn: string;
  labelJa?: string;
  descriptionEn: string;
  descriptionJa?: string;
  canRecruit: boolean;
  canDismiss: boolean;
  canAssignTasks: boolean;
  /** Leader が team_create_role / team_recruit(role_definition=...) で動的ロールを作れるか */
  canCreateRoleProfile: boolean;
  defaultEngine: string;
  singleton: boolean;
}

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
    /** Issue #29: renderer 側で project root が切り替わったとき Rust 側 state を同期する */
    setProjectRoot: (projectRoot: string): Promise<void> =>
      invoke('app_set_project_root', { projectRoot }),
    restart: (): Promise<void> => invoke('app_restart'),
    setWindowTitle: (title: string): Promise<void> => invoke('app_set_window_title', { title }),
    checkClaude: (command: string): Promise<ClaudeCheckResult> =>
      invoke('app_check_claude', { command }),
    setZoomLevel: (level: number): Promise<void> => invoke('app_set_zoom_level', { level }),
    /**
     * Issue #260 PR-1: テーマに応じて OS ネイティブの window effect (Windows: Acrylic /
     * macOS: vibrancy) を切り替える。Linux 等は no-op (applied=false で返る)。
     * 引数を `ThemeName` に絞ることで誤った文字列での呼び出しをコンパイル時に弾く。
     */
    setWindowEffects: (theme: ThemeName): Promise<SetWindowEffectsResult> =>
      invoke('app_set_window_effects', { theme }),
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
    /** RoleProfile summary を Hub へ同期 (team_list_role_profiles / permissions 検証用) */
    setRoleProfileSummary: (summary: RoleProfileSummary[]): Promise<void> =>
      invoke('app_set_role_profile_summary', { summary }),
    /** recruit を手動キャンセル (timeout 待ち中にユーザーがカードを × で閉じた等) */
    cancelRecruit: (agentId: string): Promise<void> =>
      invoke('app_cancel_recruit', { agentId }),
    /**
     * `<projectRoot>/.claude/skills/vibe-team/SKILL.md` を書き出す。
     * setupTeamMcp でも best-effort で実行されるが、Onboarding / 設定 UI から手動で
     * 強制再配置 (forceOverwrite=true) したい場合のために露出する。
     */
    installVibeTeamSkill: (
      projectRoot: string,
      forceOverwrite?: boolean
    ): Promise<{
      ok: boolean;
      path?: string;
      skipped?: boolean;
      overwritten?: boolean;
      error?: string;
    }> =>
      invoke('app_install_vibe_team_skill', { projectRoot, forceOverwrite: !!forceOverwrite }),
    getUserInfo: (): Promise<AppUserInfo> => invoke('app_get_user_info'),
    openExternal: (url: string): Promise<OpenExternalResult> => invoke('app_open_external', { url }),
    /** Issue #251: OS のファイルマネージャで親フォルダを開き該当ファイルをハイライト */
    revealInFileManager: (path: string): Promise<OpenExternalResult> =>
      invoke('app_reveal_in_file_manager', { path })
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
    /**
     * Issue #65 / #104 / #102 / #119: external-change 検出と元 encoding の保持。
     *   - expectedMtimeMs: 開いた時点の mtime
     *   - expectedSizeBytes: 開いた時点の size (mtime 解像度の補完)
     *   - encoding: 開いたときに検出した encoding。指定するとその encoding で再エンコードされる
     *   - expectedContentHash: 開いた時点の SHA-256 (hex)。同サイズかつ 1 秒以内の編集が
     *     mtime/size 両方で見逃されるケースを内容ハッシュで補完検出する。
     */
    write: (
      projectRoot: string,
      relPath: string,
      content: string,
      expectedMtimeMs?: number,
      expectedSizeBytes?: number,
      encoding?: string,
      expectedContentHash?: string
    ): Promise<FileWriteResult> =>
      invoke('files_write', {
        projectRoot,
        relPath,
        content,
        expectedMtimeMs,
        expectedSizeBytes,
        encoding,
        expectedContentHash
      })
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
    /** Issue #132: 複数チームを 1 IPC + 1 disk write でまとめて保存する */
    saveBatch: (entries: TeamHistoryEntry[]): Promise<MutationResult> =>
      invoke('team_history_save_batch', { entries }),
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
    // 既定値とのマージや schemaVersion 判定は settings-migrate.ts に集約する。
    // ここで先に DEFAULT_SETTINGS を混ぜると、旧設定に現在の schemaVersion が
    // 入ってしまい、必要なマイグレーションがスキップされる。
    load: (): Promise<unknown> => invoke('settings_load'),
    save: (settings: AppSettings): Promise<void> => invoke('settings_save', { settings })
  },

  roleProfiles: {
    load: (): Promise<RoleProfilesFile | null> => invoke('role_profiles_load'),
    save: (file: RoleProfilesFile): Promise<void> => invoke('role_profiles_save', { file })
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
      subscribeEvent<string>(`terminal:sessionId:${id}`, cb),

    /** Issue #285: pre-subscribe 用。`terminal.create` 前に await して使う。 */
    onDataReady: (id: string, cb: (data: string) => void): Promise<() => void> =>
      subscribeEventReady<string>(`terminal:data:${id}`, cb),

    onExitReady: (id: string, cb: (info: TerminalExitInfo) => void): Promise<() => void> =>
      subscribeEventReady<TerminalExitInfo>(`terminal:exit:${id}`, cb),

    onSessionIdReady: (id: string, cb: (sessionId: string) => void): Promise<() => void> =>
      subscribeEventReady<string>(`terminal:sessionId:${id}`, cb)
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

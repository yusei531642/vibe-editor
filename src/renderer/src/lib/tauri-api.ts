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
 * `window.confirm()` は Tauri WebView2 では `dialog.confirm not allowed` 例外で
 * 必ず unhandledrejection を起こすため使用禁止。代わりに `@tauri-apps/plugin-dialog`
 * の ask() をネイティブダイアログとして表示する。
 *
 * 同期的な呼び出し ( `if (window.confirm(...))` ) を async に置き換える際の helper。
 * Tauri 環境外 (Vite-only dev / テスト) では `globalThis.confirm` にフォールバック。
 */
export async function confirmAsync(
  message: string,
  opts?: { title?: string; kind?: 'info' | 'warning' | 'error' }
): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if (!isTauri()) {
    // ブラウザ / Vite SSR テスト環境
    return typeof globalThis.confirm === 'function' ? globalThis.confirm(message) : true;
  }
  try {
    const mod = await import('@tauri-apps/plugin-dialog');
    return await mod.ask(message, {
      title: opts?.title ?? 'vibe-editor',
      kind: opts?.kind ?? 'warning'
    });
  } catch (err) {
    console.warn('[confirmAsync] dialog.ask failed:', err);
    return false;
  }
}

/**
 * Tauri SDK の `unlisten()` は HMR / StrictMode の二重 mount 等の race で
 * `Cannot read properties of undefined (reading 'handlerId')` を投げることがある。
 * cleanup 経路でこれが unhandledrejection に乗ると app 全体が white-screen するので、
 * unlisten 由来の例外は握り潰す。listener leak は HMR 時のみ発生し、ページリロードで掃除される。
 */
export function safeUnlisten(u: UnlistenFn | null | undefined): void {
  if (!u) return;
  try {
    const r = u();
    // unlisten が稀に Promise を返す実装でも reject を握り潰す
    if (r && typeof (r as Promise<unknown>).then === 'function') {
      (r as Promise<unknown>).catch(() => undefined);
    }
  } catch {
    /* swallow — see comment above */
  }
}

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
  })
    .then((u) => {
      if (disposed) {
        safeUnlisten(u);
      } else {
        unlisten = u;
      }
    })
    .catch(() => undefined);
  return () => {
    disposed = true;
    safeUnlisten(unlisten);
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
  type RoleProfilesFile,
  type SessionInfo,
  type TeamHistoryEntry,
  type TerminalCreateOptions,
  type TerminalCreateResult,
  type TerminalExitInfo
} from '../../../types/shared';

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
export interface AppLogInfo {
  path: string;
  content: string;
  exists: boolean;
  truncated: boolean;
  maxBytes: number;
}

export const api = {
  ping: (): Promise<string> => invoke('ping'),

  app: {
    getProjectRoot: (): Promise<string> => invoke('app_get_project_root'),
    /** Issue #29: renderer 側で project root が切り替わったとき Rust 側 state を同期する */
    setProjectRoot: (projectRoot: string): Promise<void> =>
      invoke('app_set_project_root', { projectRoot }),
    restart: (): Promise<void> => invoke('app_restart'),
    /** PTY を全 kill してプロセスを完全終了する。設定モーダル/トレイ Quit から呼ぶ。 */
    quit: (): Promise<void> => invoke('app_quit'),
    setWindowTitle: (title: string): Promise<void> => invoke('app_set_window_title', { title }),
    checkClaude: (command: string): Promise<ClaudeCheckResult> =>
      invoke('app_check_claude', { command }),
    setZoomLevel: (level: number): Promise<void> => invoke('app_set_zoom_level', { level }),
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
    openExternal: (url: string): Promise<OpenExternalResult> =>
      invoke('app_open_external', { url }),
    revealPath: (path: string): Promise<OpenExternalResult> =>
      invoke('app_reveal_path', { path }),
    getLogInfo: (maxBytes?: number): Promise<AppLogInfo> =>
      invoke('app_get_log_info', { maxBytes }),
    clearLog: (): Promise<MutationResult> => invoke('app_clear_log'),
    appendRendererLog: (
      level: 'error' | 'warn' | 'info' | 'debug',
      message: string
    ): Promise<MutationResult> =>
      invoke('app_append_renderer_log', { level, message })
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
      invoke('sessions_list', { projectRoot }),
    /**
     * Canvas restore で `--resume <id>` を付ける前の存在チェック。
     * jsonl ファイルが消えている / 別 project に紐付いていると Claude CLI が
     * 即死してターミナルにスタックトレースを吐くため、AgentNodeCard が事前検証する。
     */
    exists: (projectRoot: string, sessionId: string): Promise<boolean> =>
      invoke('session_exists', { projectRoot, sessionId })
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
    load: async (): Promise<AppSettings> => {
      // Rust 側は未保存の場合 null を返す。null は React 側で扱えないため
      // DEFAULT_SETTINGS にフォールバック + 部分マージで欠損キーを補完。
      const raw = await invoke<Partial<AppSettings> | null>('settings_load');
      return { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
    },
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

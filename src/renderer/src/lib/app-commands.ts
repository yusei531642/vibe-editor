import type { AppSettings, ThemeName } from '../../../types/shared';
import type { Command } from './commands';
import type { SidebarView } from '../components/Sidebar';

/** コマンドパレットでサイクル可能なテーマ一覧。`theme.${name}` コマンドの種に使う。 */
export const THEMES_FOR_PALETTE: ThemeName[] = [
  'claude-dark',
  'claude-light',
  'dark',
  'midnight',
  'glass',
  'light'
];

type Tone = 'info' | 'success' | 'warning' | 'error';
type ShowToast = (
  message: string,
  options?: { tone?: Tone; durationMs?: number; id?: number }
) => number;
type DismissToast = (id: number) => void;
type T = (key: string, params?: Record<string, string | number>) => string;

/**
 * `buildAppCommands` の依存。App.tsx で hook 戻り値や handler を集めて渡す。
 *
 * - 配列 `recentlyClosed` / `terminalTabs` / `diffTabs` を生で渡さず、必要な
 *   `length` や `recentProjects` slice を渡すことで useMemo の identity 振動を防ぐ。
 * - i18n 関数 `t` は呼び出し時にビルド (現状仕様)。言語切替時は呼び出し側 useMemo の
 *   deps `[t, ...]` で再計算される。
 */
export interface AppCommandsDeps {
  // i18n
  t: T;

  // プロジェクト系 (use-project-loader 戻り値ブリッジ)
  handleNewProject: () => Promise<void> | void;
  handleOpenFolder: () => Promise<void> | void;
  handleOpenFile: () => Promise<void> | void;
  handleOpenRecent: (path: string) => Promise<void> | void;
  handleAddWorkspaceFolder: () => Promise<void> | void;

  // ビュー / サイドバー
  setSidebarView: (v: SidebarView) => void;

  // ファイルタブ (use-file-tabs)
  activeTabId: string | null;
  cycleTab: (direction: 1 | -1) => void;
  closeTab: (id: string) => void;
  togglePin: (id: string) => void;
  reopenLastClosed: () => void;
  diffTabsLength: number;
  recentlyClosedLength: number;

  // git / sessions
  refreshGit: () => Promise<void> | void;
  refreshSessions: () => Promise<void> | void;

  // ターミナル (use-terminal-tabs)
  terminalTabsLength: number;
  /** ターミナル上限。use-terminal-tabs.ts の MAX_TERMINALS。 */
  maxTerminals: number;
  activeTerminalTabId: number;
  addTerminalTab: (opts: { agent: 'claude' | 'codex' }) => void;
  closeTerminalTab: (id: number) => void;
  restartTerminal: () => void;

  // 設定
  /** settings 全体ではなく、コマンドパレットが実際に使う 4 項目だけを受ける。 */
  settings: {
    theme: ThemeName;
    density: AppSettings['density'];
    recentProjects?: string[];
    language: AppSettings['language'];
  };
  updateSettings: (patch: Partial<AppSettings>) => Promise<void> | void;
  setSettingsOpen: (open: boolean) => void;

  // アプリ
  handleRestart: () => Promise<void> | void;

  // toast (updater check 用)
  showToast: ShowToast;
  dismissToast: DismissToast;
}

/**
 * Issue #373 Phase 1-9: コマンドパレット用 Command[] を組み立てる pure 関数。
 *
 * 副作用なし: 配列を return するだけ。`run` / `when` のクロージャが deps を
 * closure-capture するので、deps が freshness 不変なら呼び出されるだけで OK。
 *
 * useMemo の deps 配列は **呼び出し側 (App.tsx)** で組む流儀。これにより
 * `react-hooks/exhaustive-deps` が呼び出し側で機能し続け、依存漏れ検出力を保つ。
 *
 * 純粋関数として `lib/team-prompts.ts` と同じ系譜の置き場 (`lib/*.ts`)。
 */
export function buildAppCommands(deps: AppCommandsDeps): Command[] {
  const {
    t,
    handleNewProject,
    handleOpenFolder,
    handleOpenFile,
    handleOpenRecent,
    handleAddWorkspaceFolder,
    setSidebarView,
    activeTabId,
    cycleTab,
    closeTab,
    togglePin,
    reopenLastClosed,
    diffTabsLength,
    recentlyClosedLength,
    refreshGit,
    refreshSessions,
    terminalTabsLength,
    maxTerminals,
    activeTerminalTabId,
    addTerminalTab,
    closeTerminalTab,
    restartTerminal,
    settings,
    updateSettings,
    setSettingsOpen,
    handleRestart,
    showToast,
    dismissToast
  } = deps;

  // Issue #57: タイトル / カテゴリ / subtitle を i18n キー経由に置換
  const CAT = {
    project: t('cmd.cat.project'),
    workspace: t('cmd.cat.workspace'),
    view: t('cmd.cat.view'),
    tab: t('cmd.cat.tab'),
    git: t('cmd.cat.git'),
    sessions: t('cmd.cat.sessions'),
    terminal: t('cmd.cat.terminal'),
    settings: t('cmd.cat.settings'),
    theme: t('cmd.cat.theme')
  };

  return [
    {
      id: 'project.new',
      title: t('cmd.project.new'),
      category: CAT.project,
      run: () => void handleNewProject()
    },
    {
      id: 'project.openFolder',
      title: t('cmd.project.openFolder'),
      category: CAT.project,
      run: () => void handleOpenFolder()
    },
    {
      id: 'project.openFile',
      title: t('cmd.project.openFile'),
      category: CAT.project,
      run: () => void handleOpenFile()
    },
    {
      id: 'workspace.addFolder',
      title: t('cmd.workspace.addFolder'),
      category: CAT.workspace,
      run: () => void handleAddWorkspaceFolder()
    },
    ...(settings.recentProjects ?? []).slice(0, 5).map<Command>((p) => ({
      id: `project.recent.${p}`,
      title: t('cmd.project.recent', { name: p.split(/[\\/]/).pop() ?? p }),
      subtitle: p,
      category: CAT.project,
      run: () => void handleOpenRecent(p)
    })),
    {
      id: 'view.sidebar.changes',
      title: t('cmd.view.sidebarChanges'),
      category: CAT.view,
      run: () => setSidebarView('changes')
    },
    {
      id: 'view.sidebar.sessions',
      title: t('cmd.view.sidebarSessions'),
      category: CAT.view,
      run: () => setSidebarView('sessions')
    },
    {
      id: 'view.nextTab',
      title: t('cmd.view.nextTab'),
      subtitle: 'Ctrl+Tab',
      category: CAT.view,
      when: () => diffTabsLength > 0,
      run: () => cycleTab(1)
    },
    {
      id: 'view.prevTab',
      title: t('cmd.view.prevTab'),
      subtitle: 'Ctrl+Shift+Tab',
      category: CAT.view,
      when: () => diffTabsLength > 0,
      run: () => cycleTab(-1)
    },
    {
      id: 'tab.close',
      title: t('cmd.tab.close'),
      subtitle: 'Ctrl+W',
      category: CAT.tab,
      when: () => !!activeTabId,
      run: () => {
        if (activeTabId) closeTab(activeTabId);
      }
    },
    {
      id: 'tab.reopen',
      title: t('cmd.tab.reopen'),
      subtitle: 'Ctrl+Shift+T',
      category: CAT.tab,
      when: () => recentlyClosedLength > 0,
      run: () => reopenLastClosed()
    },
    {
      id: 'tab.togglePin',
      title: t('cmd.tab.togglePin'),
      category: CAT.tab,
      when: () => !!activeTabId,
      run: () => {
        if (activeTabId) togglePin(activeTabId);
      }
    },
    {
      id: 'git.refresh',
      title: t('cmd.git.refresh'),
      category: CAT.git,
      run: () => void refreshGit()
    },
    {
      id: 'sessions.refresh',
      title: t('cmd.sessions.refresh'),
      category: CAT.sessions,
      run: () => void refreshSessions()
    },
    {
      id: 'terminal.addClaude',
      title: t('cmd.terminal.addClaude'),
      subtitle: `${terminalTabsLength}/${maxTerminals}`,
      category: CAT.terminal,
      when: () => terminalTabsLength < maxTerminals,
      run: () => {
        addTerminalTab({ agent: 'claude' });
      }
    },
    {
      id: 'terminal.addCodex',
      title: t('cmd.terminal.addCodex'),
      subtitle: `${terminalTabsLength}/${maxTerminals}`,
      category: CAT.terminal,
      when: () => terminalTabsLength < maxTerminals,
      run: () => {
        addTerminalTab({ agent: 'codex' });
      }
    },
    {
      id: 'terminal.closeTab',
      title: t('cmd.terminal.closeTab'),
      category: CAT.terminal,
      when: () => terminalTabsLength > 1,
      run: () => closeTerminalTab(activeTerminalTabId)
    },
    {
      id: 'terminal.restart',
      title: t('cmd.terminal.restart'),
      category: CAT.terminal,
      run: () => restartTerminal()
    },
    {
      id: 'settings.open',
      title: t('cmd.settings.open'),
      subtitle: 'Ctrl+,',
      category: CAT.settings,
      run: () => setSettingsOpen(true)
    },
    {
      id: 'settings.cycleDensity',
      title: t('cmd.settings.cycleDensity'),
      subtitle: t('cmd.settings.cycleDensitySub', { density: settings.density }),
      category: CAT.settings,
      run: () => {
        const order: typeof settings.density[] = ['compact', 'normal', 'comfortable'];
        const nextDensity = order[(order.indexOf(settings.density) + 1) % order.length];
        void updateSettings({ density: nextDensity });
      }
    },
    ...THEMES_FOR_PALETTE.map<Command>((tn) => ({
      id: `theme.${tn}`,
      title: t('cmd.theme.title', { name: tn }),
      subtitle: tn === settings.theme ? t('cmd.theme.current') : undefined,
      category: CAT.theme,
      run: () => void updateSettings({ theme: tn })
    })),
    {
      id: 'app.restart',
      title: t('cmd.app.restart'),
      category: t('cmd.cat.app'),
      run: () => void handleRestart()
    },
    {
      id: 'app.checkForUpdates',
      title: t('updater.checkNow'),
      category: t('cmd.cat.app'),
      run: () => {
        void import('./updater-check').then((m) => {
          // manual=true: didCheck を無視して再試行可能 + 「最新です」も明示通知
          void m.checkForUpdates({
            language: settings.language,
            showToast,
            dismissToast,
            manual: true,
            runningTaskCount: terminalTabsLength
          });
        });
      }
    }
  ];
}

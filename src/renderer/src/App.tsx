import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Command as CommandIcon, Crown, Plus, RotateCw, Settings as SettingsIcon, Users } from 'lucide-react';
import type {
  GitDiffResult,
  GitFileChange,
  GitStatus,
  SessionInfo,
  Team,
  TeamMember,
  TeamPreset,
  TeamRole,
  TerminalAgent,
  ThemeName
} from '../../types/shared';
import { Sidebar, type SidebarView } from './components/Sidebar';
import { TabBar, type TabItem } from './components/TabBar';
import { Toolbar } from './components/Toolbar';
import { AppMenu } from './components/AppMenu';
import { DiffView } from './components/DiffView';
import { TerminalView, type TerminalViewHandle } from './components/TerminalView';
import { SettingsModal } from './components/SettingsModal';
import { CommandPalette } from './components/CommandPalette';
import { WelcomePane } from './components/WelcomePane';
import { ContextMenu, type ContextMenuItem } from './components/ContextMenu';
import { ClaudeNotFound } from './components/ClaudeNotFound';
import { TeamCreateModal } from './components/TeamCreateModal';
import { useT } from './lib/i18n';
import { useSettings } from './lib/settings-context';
import { useToast } from './lib/toast-context';
import { parseShellArgs } from './lib/parse-args';
import type { Command } from './lib/commands';

const THEMES_FOR_PALETTE: ThemeName[] = [
  'claude-dark',
  'claude-light',
  'dark',
  'midnight',
  'light'
];

interface DiffTab {
  id: string;
  relPath: string;
  result: GitDiffResult | null;
  loading: boolean;
  pinned: boolean;
}

const MAX_TERMINALS = 10;

interface TerminalTab {
  id: number;
  version: number;
  agent: TerminalAgent;
  role: TeamRole | null;
  teamId: string | null;
  /** MCP チーム通信用のエージェント識別子 */
  agentId: string;
  status: string;
  exited: boolean;
  resumeSessionId: string | null;
  hasActivity: boolean;
}

/** ロール別の短い説明（チームプロンプト内で使用） */
const ROLE_DESC: Record<TeamRole, string> = {
  leader: '全体の調整・指示・タスク割り振り',
  planner: '実装計画の作成・タスク分解・アーキテクチャ設計',
  programmer: '計画に基づいた高品質なコード実装',
  researcher: 'コードベース調査・ドキュメント確認・API調査',
  reviewer: 'コードレビュー・バグ特定・改善提案'
};

/** チームのシステムプロンプト（--append-system-prompt 用） */
function generateTeamSystemPrompt(
  tab: TerminalTab,
  allTabs: TerminalTab[],
  team: Team | null
): string | undefined {
  if (!tab.role || !tab.teamId || !team) return undefined;

  const teamTabs = allTabs.filter((t) => t.teamId === tab.teamId);
  const roster = teamTabs
    .map((t) => {
      const agent = t.agent === 'claude' ? 'Claude Code' : 'Codex';
      const you = t.id === tab.id ? ' ← あなた' : '';
      return `${t.role ?? 'member'}(${agent})${you}`;
    })
    .join(', ');

  const mcpTools = 'MCP vive-team ツール: team_send(to,message), team_read(), team_assign_task(assignee,description), team_get_tasks(), team_update_task(task_id,status), team_status(status)';

  if (tab.role === 'leader') {
    return `あなたはチーム「${team.name}」のLeader。構成: ${roster}。${mcpTools}。手順: 1)プロジェクト調査 2)計画立案 3)team_assign_taskでタスク割振 4)team_readで進捗確認・team_sendで指示`;
  }

  return `あなたはチーム「${team.name}」の${tab.role}。役割:${ROLE_DESC[tab.role]}。構成: ${roster}。${mcpTools}。team_readでLeaderの指示を確認し、作業後team_sendで報告。`;
}

/** 短いアクション指示（initialMessage 用） */
function generateTeamAction(tab: TerminalTab): string | undefined {
  if (!tab.role || !tab.teamId) return undefined;

  if (tab.role === 'leader') {
    return 'プロジェクトを調査し、チームメンバーにタスクを割り振ってください。';
  }
  return 'team_read()でLeaderからのタスク指示を確認して作業を開始してください。';
}

export function App(): JSX.Element {
  const { settings, update: updateSettings, reset: resetSettings } = useSettings();
  const { showToast } = useToast();
  const t = useT();
  const [projectRoot, setProjectRoot] = useState<string>('');
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [paletteOpen, setPaletteOpen] = useState<boolean>(false);
  const [status, setStatus] = useState<string>('');

  // sidebar
  const [sidebarView, setSidebarView] = useState<SidebarView>('changes');

  // git
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [gitLoading, setGitLoading] = useState<boolean>(true);

  // sessions
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState<boolean>(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  // tabs (diff only — エディタタブは無し)
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [diffTabs, setDiffTabs] = useState<DiffTab[]>([]);
  const [recentlyClosed, setRecentlyClosed] = useState<DiffTab[]>([]);
  const [sideBySide, setSideBySide] = useState<boolean>(true);

  // Claude Code / Codex terminal tabs (最大10個の同時実行をサポート)
  const [terminalTabs, setTerminalTabs] = useState<TerminalTab[]>([]);
  const [activeTerminalTabId, setActiveTerminalTabId] = useState<number>(0);
  const nextTerminalIdRef = useRef(1);
  const terminalRefs = useRef(new Map<number, TerminalViewHandle>());
  const [tabCreateMenuOpen, setTabCreateMenuOpen] = useState(false);
  const [teamModalOpen, setTeamModalOpen] = useState(false);
  const [teams, setTeams] = useState<Team[]>([]);
  const [pendingTeamClose, setPendingTeamClose] = useState<{
    tabId: number;
    teamId: string;
  } | null>(null);
  const [dragTabId, setDragTabId] = useState<number | null>(null);
  const [dragOverTabId, setDragOverTabId] = useState<number | null>(null);

  // Claude CLI 検査状態
  const [claudeCheck, setClaudeCheck] = useState<{
    state: 'checking' | 'ok' | 'missing';
    error?: string;
  }>({ state: 'checking' });

  // コンテキストメニュー
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    items: ContextMenuItem[];
  } | null>(null);

  const addTerminalTab = useCallback(
    (opts?: {
      agent?: TerminalAgent;
      role?: TeamRole | null;
      teamId?: string | null;
      resumeSessionId?: string | null;
      agentId?: string;
    }): number => {
      const id = nextTerminalIdRef.current++;
      const tab: TerminalTab = {
        id,
        version: 0,
        agent: opts?.agent ?? 'claude',
        role: opts?.role ?? null,
        teamId: opts?.teamId ?? null,
        agentId: opts?.agentId ?? `agent-${id}`,
        status: '',
        exited: false,
        resumeSessionId: opts?.resumeSessionId ?? null,
        hasActivity: false
      };
      setTerminalTabs((prev) => {
        if (prev.length >= MAX_TERMINALS) return prev;
        return [...prev, tab];
      });
      setActiveTerminalTabId(id);
      return id;
    },
    []
  );

  const doCloseTab = useCallback((tabId: number) => {
    setTerminalTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      if (next.length === 0) {
        // 最後の1個 → 新しいスタンドアロンタブを自動生成
        const newId = nextTerminalIdRef.current++;
        const fresh: TerminalTab = {
          id: newId,
          version: 1,
          agent: 'claude',
          role: null,
          teamId: null,
          agentId: `agent-${newId}`,
          status: '',
          exited: false,
          resumeSessionId: null,
          hasActivity: false
        };
        setActiveTerminalTabId(newId);
        return [fresh];
      }
      setActiveTerminalTabId((active) => {
        if (active !== tabId) return active;
        const idx = prev.findIndex((t) => t.id === tabId);
        const neighbor = next[Math.min(idx, next.length - 1)];
        return neighbor?.id ?? next[0]?.id ?? 0;
      });
      return next;
    });
  }, []);

  const doCloseTeam = useCallback(
    (teamId: string) => {
      setTerminalTabs((prev) => {
        const next = prev.filter((t) => t.teamId !== teamId);
        if (next.length === 0) {
          // チーム全員しかいない場合 → 新しいスタンドアロンタブを自動生成
          const newId = nextTerminalIdRef.current++;
          const fresh: TerminalTab = {
            id: newId,
            version: 1,
            agent: 'claude',
            role: null,
            teamId: null,
            agentId: `agent-${newId}`,
            status: '',
            exited: false,
            resumeSessionId: null,
            hasActivity: false
          };
          setActiveTerminalTabId(newId);
          return [fresh];
        }
        setActiveTerminalTabId((active) => {
          if (next.some((t) => t.id === active)) return active;
          return next[next.length - 1].id;
        });
        return next;
      });
      setTeams((prev) => prev.filter((t) => t.id !== teamId));
      // MCP クリーンアップ
      if (projectRoot) {
        void window.api.app.cleanupTeamMcp(projectRoot, teamId);
      }
    },
    []
  );

  const closeTerminalTab = useCallback(
    (tabId: number) => {
      const tab = terminalTabs.find((t) => t.id === tabId);
      if (tab?.role === 'leader' && tab.teamId) {
        setPendingTeamClose({ tabId, teamId: tab.teamId });
        return;
      }
      doCloseTab(tabId);
    },
    [terminalTabs, doCloseTab]
  );

  const restartTerminalTab = useCallback((tabId: number) => {
    setTerminalTabs((prev) =>
      prev.map((t) =>
        t.id === tabId
          ? { ...t, version: t.version + 1, exited: false, status: '', hasActivity: false }
          : t
      )
    );
  }, []);

  const restartTerminal = useCallback(() => {
    restartTerminalTab(activeTerminalTabId);
  }, [activeTerminalTabId, restartTerminalTab]);

  // ---------- Claude CLI 検査 ----------
  const runClaudeCheck = useCallback(async () => {
    setClaudeCheck({ state: 'checking' });
    try {
      const res = await window.api.app.checkClaude(settings.claudeCommand || 'claude');
      setClaudeCheck(
        res.ok
          ? { state: 'ok' }
          : { state: 'missing', error: res.error }
      );
    } catch (err) {
      setClaudeCheck({ state: 'missing', error: String(err) });
    }
  }, [settings.claudeCommand]);

  // 設定の claudeCommand が変わるたびに再検査
  useEffect(() => {
    void runClaudeCheck();
  }, [runClaudeCheck]);

  // ---------- Claude Code パネル リサイズ ----------
  const MIN_PANEL = 320;
  const MAX_PANEL = 900;
  const resizeDragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // 設定からの初期幅を CSS 変数に反映
  useEffect(() => {
    const w = Math.max(
      MIN_PANEL,
      Math.min(MAX_PANEL, settings.claudeCodePanelWidth ?? 460)
    );
    document.documentElement.style.setProperty('--claude-code-width', `${w}px`);
  }, [settings.claudeCodePanelWidth]);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      const currentWidth = Math.max(
        MIN_PANEL,
        Math.min(MAX_PANEL, settings.claudeCodePanelWidth ?? 460)
      );
      resizeDragRef.current = {
        startX: e.clientX,
        startWidth: currentWidth
      };
      document.body.classList.add('is-resizing');
      const handleEl = e.currentTarget;
      handleEl.classList.add('is-dragging');

      let latestWidth = currentWidth;

      const onMove = (ev: MouseEvent): void => {
        const drag = resizeDragRef.current;
        if (!drag) return;
        const dx = drag.startX - ev.clientX; // 左へドラッグ = width 増える
        const next = Math.max(
          MIN_PANEL,
          Math.min(MAX_PANEL, drag.startWidth + dx)
        );
        latestWidth = next;
        // ドラッグ中は CSS 変数を直接書き換え（React 再レンダリング回避）
        document.documentElement.style.setProperty(
          '--claude-code-width',
          `${next}px`
        );
      };

      const onUp = (): void => {
        resizeDragRef.current = null;
        document.body.classList.remove('is-resizing');
        handleEl.classList.remove('is-dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        // 確定値を設定に保存
        void updateSettings({ claudeCodePanelWidth: latestWidth });
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [settings.claudeCodePanelWidth, updateSettings]
  );

  /** 指定ルートでプロジェクトを読み込み直す */
  const loadProject = useCallback(
    async (root: string, options: { addToRecent?: boolean } = { addToRecent: true }) => {
      setProjectRoot(root);
      setStatus('プロジェクト読み込み中…');
      setGitLoading(true);

      try {
        const [gs, sess] = await Promise.all([
          window.api.git.status(root),
          window.api.sessions.list(root)
        ]);
        // MCP 初期化は失敗しても git/sessions 読み込みに影響させない
        window.api.app.setupTeamMcp(root, '_init', '', []).catch((err) => {
          console.warn('[loadProject] setupTeamMcp failed:', err);
        });

        setGitStatus(gs);
        setSessions(sess);
        // タブ・セッション状態をリセット
        setDiffTabs([]);
        setRecentlyClosed([]);
        setActiveTabId(null);
        setActiveSessionId(null);
        // ターミナル＆チームをリセット（全タブ閉じて新規1つ）
        setTeams([]);
        const newId = nextTerminalIdRef.current++;
        setTerminalTabs([
          {
            id: newId,
            version: 0,
            agent: 'claude',
            role: null,
            teamId: null,
            agentId: `agent-${newId}`,
            status: '起動中…',
            exited: false,
            resumeSessionId: null,
            hasActivity: false
          }
        ]);
        setActiveTerminalTabId(newId);
        setStatus(`${root.split(/[\\/]/).pop()}`);
        if (options.addToRecent !== false) {
          const rp = settings.recentProjects ?? [];
          const next = [root, ...rp.filter((p) => p !== root)].slice(0, 10);
          void updateSettings({ recentProjects: next });
        }
      } catch (err) {
        setStatus(`読み込みエラー: ${String(err)}`);
      } finally {
        setGitLoading(false);
      }
    },
    [settings.recentProjects, updateSettings]
  );

  // 初回ロード
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const root = await window.api.app.getProjectRoot();
        if (cancelled) return;
        setProjectRoot(root);
        const [gs, sess] = await Promise.all([
          window.api.git.status(root),
          window.api.sessions.list(root)
        ]);
        // MCP 初期化は失敗しても git/sessions 読み込みに影響させない
        window.api.app.setupTeamMcp(root, '_init', '', []).catch((err) => {
          console.warn('[init] setupTeamMcp failed:', err);
        });
        if (cancelled) return;
        setGitStatus(gs);
        setGitLoading(false);
        setSessions(sess);
        setStatus(root.split(/[\\/]/).pop() ?? root);
      } catch (err) {
        setStatus(`初期化エラー: ${String(err)}`);
        setGitLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // タイトルバー
  useEffect(() => {
    const name = projectRoot.split(/[\\/]/).pop() || 'vibe-editor';
    window.api.app.setWindowTitle(`vibe-editor — ${name}`).catch(() => undefined);
  }, [projectRoot]);

  const handleRestart = useCallback(async () => {
    await window.api.app.restart();
  }, []);

  // ---------- データ更新 ----------

  const refreshGit = useCallback(async () => {
    if (!projectRoot) return;
    setGitLoading(true);
    try {
      const gs = await window.api.git.status(projectRoot);
      setGitStatus(gs);
    } finally {
      setGitLoading(false);
    }
  }, [projectRoot]);

  const refreshSessions = useCallback(async () => {
    if (!projectRoot) return;
    setSessionsLoading(true);
    try {
      const sess = await window.api.sessions.list(projectRoot);
      setSessions(sess);
    } finally {
      setSessionsLoading(false);
    }
  }, [projectRoot]);

  useEffect(() => {
    if (sidebarView === 'sessions') void refreshSessions();
  }, [sidebarView, refreshSessions]);

  const openDiffTab = useCallback(
    async (file: GitFileChange) => {
      if (!projectRoot) return;
      const id = `diff:${file.path}`;
      setActiveTabId(id);
      setDiffTabs((prev) => {
        if (prev.some((t) => t.id === id)) return prev;
        return [
          ...prev,
          { id, relPath: file.path, result: null, loading: true, pinned: false }
        ];
      });
      try {
        const result = await window.api.git.diff(projectRoot, file.path);
        setDiffTabs((prev) =>
          prev.map((t) => (t.id === id ? { ...t, result, loading: false } : t))
        );
      } catch (err) {
        setDiffTabs((prev) =>
          prev.map((t) =>
            t.id === id
              ? {
                  ...t,
                  loading: false,
                  result: {
                    ok: false,
                    error: String(err),
                    path: file.path,
                    isNew: false,
                    isDeleted: false,
                    isBinary: false,
                    original: '',
                    modified: ''
                  }
                }
              : t
          )
        );
      }
    },
    [projectRoot]
  );

  // ---------- 差分レビュー依頼 ----------

  /** 指定ファイルの変更を Claude Code にレビュー依頼するプロンプトを生成して ターミナルに送信 */
  const reviewDiff = useCallback(
    (file: GitFileChange) => {
      const prompt =
        settings.language === 'en'
          ? `Please review the changes in this file and point out any issues or possible improvements: ${file.path}`
          : `このファイルの変更内容をレビューしてください。問題点や改善の余地があれば指摘してください: ${file.path}`;
      const term = terminalRefs.current.get(activeTerminalTabId);
      if (!term) {
        showToast(t('toast.terminalNotReady'), { tone: 'warning' });
        return;
      }
      term.sendCommand(prompt, true);
      showToast(t('toast.reviewRequested', { path: file.path }), { tone: 'info' });
      term.focus();
    },
    [showToast, settings.language, t, activeTerminalTabId]
  );

  const handleFileContextMenu = useCallback(
    (e: React.MouseEvent, file: GitFileChange) => {
      e.preventDefault();
      const items: ContextMenuItem[] = [
        {
          label: t('ctxMenu.openDiff'),
          action: () => void openDiffTab(file)
        },
        {
          label: t('ctxMenu.reviewDiff'),
          action: () => reviewDiff(file),
          divider: true
        },
        {
          label: t('ctxMenu.copyPath'),
          action: () => {
            void navigator.clipboard.writeText(file.path);
            showToast(t('toast.pathCopied'), { tone: 'info' });
          }
        }
      ];
      setContextMenu({ x: e.clientX, y: e.clientY, items });
    },
    [openDiffTab, reviewDiff, showToast, t]
  );

  // ---------- セッション復帰 ----------

  const handleResumeSession = useCallback(
    (session: SessionInfo) => {
      setActiveSessionId(session.id);
      showToast(`セッションに復帰: ${session.title.slice(0, 40)}`, { tone: 'info' });
      addTerminalTab({ resumeSessionId: session.id });
    },
    [showToast, addTerminalTab]
  );

  // ---------- タブ操作 ----------

  const closeTab = useCallback(
    (id: string) => {
      setDiffTabs((prev) => {
        const target = prev.find((t) => t.id === id);
        if (!target || target.pinned) return prev;
        setRecentlyClosed((rc) =>
          [target, ...rc.filter((r) => r.id !== id)].slice(0, 10)
        );
        const next = prev.filter((t) => t.id !== id);
        if (activeTabId === id) {
          setActiveTabId(next.length > 0 ? next[next.length - 1].id : null);
        }
        return next;
      });
    },
    [activeTabId]
  );

  const togglePin = useCallback((id: string) => {
    setDiffTabs((prev) =>
      prev.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t))
    );
  }, []);

  const reopenLastClosed = useCallback(() => {
    setRecentlyClosed((rc) => {
      if (rc.length === 0) return rc;
      const [first, ...rest] = rc;
      setDiffTabs((prev) => [...prev, { ...first }]);
      setActiveTabId(first.id);
      return rest;
    });
  }, []);

  const cycleTab = useCallback(
    (direction: 1 | -1) => {
      if (diffTabs.length === 0) return;
      const ids = diffTabs.map((t) => t.id);
      const idx = activeTabId ? ids.indexOf(activeTabId) : -1;
      const next = ((idx < 0 ? 0 : idx) + direction + ids.length) % ids.length;
      setActiveTabId(ids[next]);
    },
    [activeTabId, diffTabs]
  );

  // ---------- プロジェクトメニュー操作 ----------

  const handleNewProject = useCallback(async () => {
    const folder = await window.api.dialog.openFolder('新規プロジェクト: 空フォルダを選択/作成');
    if (!folder) return;
    const empty = await window.api.dialog.isFolderEmpty(folder);
    if (!empty) {
      showToast('フォルダが空ではありません。既存として開きます', { tone: 'warning' });
    } else {
      showToast('新規プロジェクトを作成', { tone: 'success' });
    }
    await loadProject(folder);
  }, [loadProject, showToast]);

  const handleOpenFolder = useCallback(async () => {
    const folder = await window.api.dialog.openFolder('既存プロジェクトを開く');
    if (!folder) return;
    await loadProject(folder);
  }, [loadProject]);

  const handleOpenFile = useCallback(async () => {
    const file = await window.api.dialog.openFile('ファイルを開く');
    if (!file) return;
    const parent = file.replace(/[\\/][^\\/]+$/, '');
    await loadProject(parent);
    showToast(`${file} の親フォルダをプロジェクトとして読み込みました`, { tone: 'info' });
  }, [loadProject, showToast]);

  const handleOpenRecent = useCallback(
    async (path: string) => {
      await loadProject(path);
    },
    [loadProject]
  );

  const handleClearRecent = useCallback(() => {
    void updateSettings({ recentProjects: [] });
    showToast('最近のプロジェクト履歴をクリアしました', { tone: 'info' });
  }, [updateSettings, showToast]);

  // ---------- コマンドパレット ----------

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [
      {
        id: 'project.new',
        title: '新規プロジェクト…',
        category: 'プロジェクト',
        run: () => void handleNewProject()
      },
      {
        id: 'project.openFolder',
        title: 'フォルダを開く…',
        category: 'プロジェクト',
        run: () => void handleOpenFolder()
      },
      {
        id: 'project.openFile',
        title: 'ファイルを開く…',
        category: 'プロジェクト',
        run: () => void handleOpenFile()
      },
      ...(settings.recentProjects ?? []).slice(0, 5).map<Command>((p) => ({
        id: `project.recent.${p}`,
        title: `最近: ${p.split(/[\\/]/).pop()}`,
        subtitle: p,
        category: 'プロジェクト',
        run: () => void handleOpenRecent(p)
      })),
      {
        id: 'view.sidebar.changes',
        title: 'サイドバー: 変更',
        category: 'ビュー',
        run: () => setSidebarView('changes')
      },
      {
        id: 'view.sidebar.sessions',
        title: 'サイドバー: 履歴',
        category: 'ビュー',
        run: () => setSidebarView('sessions')
      },
      {
        id: 'view.nextTab',
        title: '次のタブへ',
        subtitle: 'Ctrl+Tab',
        category: 'ビュー',
        when: () => diffTabs.length > 0,
        run: () => cycleTab(1)
      },
      {
        id: 'view.prevTab',
        title: '前のタブへ',
        subtitle: 'Ctrl+Shift+Tab',
        category: 'ビュー',
        when: () => diffTabs.length > 0,
        run: () => cycleTab(-1)
      },
      {
        id: 'tab.close',
        title: 'アクティブなタブを閉じる',
        subtitle: 'Ctrl+W',
        category: 'タブ',
        when: () => !!activeTabId,
        run: () => { if (activeTabId) closeTab(activeTabId); }
      },
      {
        id: 'tab.reopen',
        title: '最近閉じたタブを復元',
        subtitle: 'Ctrl+Shift+T',
        category: 'タブ',
        when: () => recentlyClosed.length > 0,
        run: () => reopenLastClosed()
      },
      {
        id: 'tab.togglePin',
        title: 'アクティブなタブをピン留め/解除',
        category: 'タブ',
        when: () => !!activeTabId,
        run: () => { if (activeTabId) togglePin(activeTabId); }
      },
      {
        id: 'git.refresh',
        title: '変更ファイル一覧を更新',
        category: 'Git',
        run: () => refreshGit()
      },
      {
        id: 'sessions.refresh',
        title: 'セッション履歴を更新',
        category: 'セッション',
        run: () => refreshSessions()
      },
      {
        id: 'terminal.addClaude',
        title: 'Claude Code タブを追加',
        subtitle: `${terminalTabs.length}/${MAX_TERMINALS}`,
        category: 'ターミナル',
        when: () => terminalTabs.length < MAX_TERMINALS,
        run: () => { addTerminalTab({ agent: 'claude' }); }
      },
      {
        id: 'terminal.addCodex',
        title: 'Codex タブを追加',
        subtitle: `${terminalTabs.length}/${MAX_TERMINALS}`,
        category: 'ターミナル',
        when: () => terminalTabs.length < MAX_TERMINALS,
        run: () => { addTerminalTab({ agent: 'codex' }); }
      },
      {
        id: 'terminal.createTeam',
        title: 'Team を作成…',
        category: 'ターミナル',
        when: () => terminalTabs.length < MAX_TERMINALS,
        run: () => setTeamModalOpen(true)
      },
      {
        id: 'terminal.closeTab',
        title: 'アクティブなターミナルタブを閉じる',
        category: 'ターミナル',
        when: () => terminalTabs.length > 1,
        run: () => closeTerminalTab(activeTerminalTabId)
      },
      {
        id: 'terminal.restart',
        title: 'ターミナルを再起動',
        category: 'ターミナル',
        run: () => restartTerminal()
      },
      {
        id: 'settings.open',
        title: '設定を開く',
        subtitle: 'Ctrl+,',
        category: '設定',
        run: () => setSettingsOpen(true)
      },
      {
        id: 'settings.cycleDensity',
        title: '情報密度を切り替え',
        subtitle: `現在: ${settings.density}`,
        category: '設定',
        run: () => {
          const order: typeof settings.density[] = ['compact', 'normal', 'comfortable'];
          const nextDensity = order[(order.indexOf(settings.density) + 1) % order.length];
          void updateSettings({ density: nextDensity });
        }
      },
      ...THEMES_FOR_PALETTE.map<Command>((tn) => ({
        id: `theme.${tn}`,
        title: `テーマ: ${tn}`,
        subtitle: tn === settings.theme ? '✓ 現在のテーマ' : undefined,
        category: 'テーマ',
        run: () => void updateSettings({ theme: tn })
      })),
      {
        id: 'app.restart',
        title: 'vibe-editor (アプリ) を再起動',
        category: 'アプリ',
        run: () => void handleRestart()
      }
    ];
    return list;
  }, [
    handleNewProject,
    handleOpenFolder,
    handleOpenFile,
    handleOpenRecent,
    cycleTab,
    activeTabId,
    closeTab,
    recentlyClosed,
    reopenLastClosed,
    togglePin,
    refreshGit,
    refreshSessions,
    settings.theme,
    settings.density,
    settings.recentProjects,
    updateSettings,
    handleRestart,
    restartTerminal,
    addTerminalTab,
    closeTerminalTab,
    activeTerminalTabId,
    terminalTabs.length,
    diffTabs.length
  ]);

  // ---------- Shift+ホイールでアプリ全体のズーム ----------

  useEffect(() => {
    let zoomLevel = 0;
    void window.api.app.getZoomLevel().then((l) => { zoomLevel = l; });
    const handler = (e: WheelEvent): void => {
      if (!e.shiftKey) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.5 : 0.5;
      zoomLevel = Math.max(-4, Math.min(4, zoomLevel + delta));
      void window.api.app.setZoomLevel(zoomLevel);
    };
    window.addEventListener('wheel', handler, { passive: false });
    return () => window.removeEventListener('wheel', handler);
  }, []);

  // ---------- グローバルショートカット ----------

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) {
        if (e.key === 'Escape') {
          if (paletteOpen) setPaletteOpen(false);
          else if (settingsOpen) setSettingsOpen(false);
        }
        return;
      }
      if (e.shiftKey && (e.key === 'P' || e.key === 'p')) {
        e.preventDefault();
        e.stopPropagation();
        setPaletteOpen((v) => !v);
        return;
      }
      if (e.key === ',') {
        e.preventDefault();
        setSettingsOpen(true);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        cycleTab(e.shiftKey ? -1 : 1);
        return;
      }
      if (e.key === 'w' || e.key === 'W') {
        if (activeTabId) {
          e.preventDefault();
          e.stopPropagation();
          closeTab(activeTabId);
        }
        return;
      }
      if (e.shiftKey && (e.key === 'T' || e.key === 't')) {
        e.preventDefault();
        reopenLastClosed();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [paletteOpen, settingsOpen, activeTabId, cycleTab, closeTab, reopenLastClosed]);

  // ---------- 起動引数合成 ----------

  const getTerminalArgs = useCallback(
    (tab: TerminalTab) => {
      const isCodex = tab.agent === 'codex';
      const base = parseShellArgs(
        isCodex ? settings.codexArgs || '' : settings.claudeArgs || ''
      );
      if (tab.resumeSessionId && !isCodex) {
        base.push('--resume', tab.resumeSessionId);
      }
      // チームのコンテキストをシステムプロンプトとして注入
      if (!isCodex && tab.teamId) {
        const team = teams.find((t) => t.id === tab.teamId) ?? null;
        const sysPrompt = generateTeamSystemPrompt(tab, terminalTabs, team);
        if (sysPrompt) {
          base.push('--append-system-prompt', sysPrompt);
        }
      }
      return base;
    },
    [settings.claudeArgs, settings.codexArgs, teams, terminalTabs]
  );

  /** チームタブ用の環境変数を構築（MCP サーバーが読み取る） */
  const [teamFilePaths, setTeamFilePaths] = useState<Record<string, string>>({});

  // チーム作成時にファイルパスを解決してキャッシュ
  useEffect(() => {
    const teamIds = teams.map((t) => t.id);
    for (const tid of teamIds) {
      if (!teamFilePaths[tid]) {
        void window.api.app.getTeamFilePath(tid).then((p) => {
          setTeamFilePaths((prev) => ({ ...prev, [tid]: p }));
        });
      }
    }
  }, [teams, teamFilePaths]);

  const getTerminalEnv = useCallback(
    (tab: TerminalTab): Record<string, string> | undefined => {
      if (!tab.teamId || !tab.role) return undefined;
      const teamFile = teamFilePaths[tab.teamId];
      if (!teamFile) return undefined;
      return {
        VIVE_TEAM_ID: tab.teamId,
        VIVE_TEAM_ROLE: tab.role,
        VIVE_AGENT_ID: tab.agentId,
        VIVE_TEAM_FILE: teamFile
      };
    },
    [teamFilePaths]
  );

  /** MCP サーバースクリプトのパス（チーム初回セットアップ用） */
  const [mcpServerPath, setMcpServerPath] = useState<string>('');
  useEffect(() => {
    void window.api.app.getMcpServerPath().then(setMcpServerPath);
  }, []);

  /** タブのロールに対応する初期メッセージ（短いアクション指示のみ） */
  const getRolePrompt = useCallback(
    (tab: TerminalTab): string | undefined => {
      if (!tab.role) return undefined;
      // スタンドアロン（チーム無し）
      if (!tab.teamId) {
        if (tab.role === 'leader') return undefined;
        return `${ROLE_DESC[tab.role]}に集中してください。`;
      }
      return generateTeamAction(tab);
    },
    []
  );

  // 初回タブ作成: Claude OK かつ projectRoot 設定済みでタブなし
  useEffect(() => {
    if (claudeCheck.state === 'ok' && projectRoot && terminalTabs.length === 0) {
      addTerminalTab();
    }
  }, [claudeCheck.state, projectRoot, terminalTabs.length, addTerminalTab]);

  // ---------- チーム作成 ----------

  const handleCreateTeam = useCallback(
    async (teamName: string, leader: { agent: TerminalAgent }, members: TeamMember[]) => {
      const totalNeeded = 1 + members.length;
      if (terminalTabs.length + totalNeeded > MAX_TERMINALS) return;

      const teamId = `team-${Date.now()}`;
      setTeams((prev) => [...prev, { id: teamId, name: teamName }]);

      // MCP 用のメンバー一覧を事前構築
      const allMembers = [
        { agentId: `${teamId}-leader`, role: 'leader', agent: leader.agent },
        ...members.map((m, i) => ({
          agentId: `${teamId}-${m.role}-${i}`,
          role: m.role,
          agent: m.agent
        }))
      ];

      // MCP サーバーをセットアップ（Claude Code / Codex MCP 設定 + チームステートファイル作成）
      if (projectRoot) {
        await window.api.app.setupTeamMcp(projectRoot, teamId, teamName, allMembers);
      }

      // Leader を先に生成
      addTerminalTab({
        agent: leader.agent,
        role: 'leader' as TeamRole,
        teamId,
        agentId: allMembers[0].agentId
      });
      // メンバーを順次生成
      for (let i = 0; i < members.length; i++) {
        addTerminalTab({
          agent: members[i].agent,
          role: members[i].role,
          teamId,
          agentId: allMembers[i + 1].agentId
        });
      }
    },
    [addTerminalTab, terminalTabs.length, projectRoot]
  );

  const handleSavePreset = useCallback(
    (preset: TeamPreset) => {
      const prev = settings.teamPresets ?? [];
      const idx = prev.findIndex((p) => p.id === preset.id);
      if (idx >= 0) {
        // 既存プリセットを更新
        const updated = [...prev];
        updated[idx] = preset;
        void updateSettings({ teamPresets: updated });
      } else {
        void updateSettings({ teamPresets: [...prev, preset] });
      }
    },
    [settings.teamPresets, updateSettings]
  );

  const handleDeletePreset = useCallback(
    (id: string) => {
      const prev = settings.teamPresets ?? [];
      void updateSettings({ teamPresets: prev.filter((p) => p.id !== id) });
    },
    [settings.teamPresets, updateSettings]
  );

  // ---------- ターミナルタブのグループ化 ----------

  const { standaloneTabList, teamGroupList } = useMemo(() => {
    const standalone = terminalTabs.filter((t) => !t.teamId);
    const teamMap = new Map<string, TerminalTab[]>();
    for (const t of terminalTabs) {
      if (t.teamId) {
        const arr = teamMap.get(t.teamId) || [];
        arr.push(t);
        teamMap.set(t.teamId, arr);
      }
    }
    const teamGroups = [...teamMap.entries()].map(([teamId, tabs]) => ({
      team: teams.find((t) => t.id === teamId) ?? { id: teamId, name: 'Team' },
      tabs: tabs.sort((a, b) => {
        if (a.role === 'leader') return -1;
        if (b.role === 'leader') return 1;
        return a.id - b.id;
      })
    }));
    return { standaloneTabList: standalone, teamGroupList: teamGroups };
  }, [terminalTabs, teams]);

  // ---------- タブリスト ----------

  const tabs: TabItem[] = diffTabs.map((t) => ({
    id: t.id,
    title: t.relPath.split('/').pop() ?? t.relPath,
    closable: true as const,
    pinned: t.pinned
  }));

  const activeDiffTab = diffTabs.find((t) => t.id === activeTabId) ?? null;
  const activeDiffPath = activeDiffTab?.relPath ?? null;

  const projectName = projectRoot.split(/[\\/]/).pop() || 'no project';
  const activeTab = terminalTabs.find((t) => t.id === activeTerminalTabId) ?? null;

  return (
    <div className={`layout${activeDiffTab ? '' : ' layout--terminal-full'}`}>
      <Sidebar
        view={sidebarView}
        onViewChange={setSidebarView}
        gitStatus={gitStatus}
        gitLoading={gitLoading}
        onRefreshGit={refreshGit}
        onOpenDiff={openDiffTab}
        onFileContextMenu={handleFileContextMenu}
        activeDiffPath={activeDiffPath}
        sessions={sessions}
        sessionsLoading={sessionsLoading}
        activeSessionId={activeSessionId}
        onRefreshSessions={refreshSessions}
        onResumeSession={handleResumeSession}
      />
      <main className="main">
        <Toolbar
          projectRoot={projectRoot}
          onRestart={handleRestart}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenPalette={() => setPaletteOpen(true)}
          status={status}
          recentProjects={settings.recentProjects ?? []}
          onNewProject={handleNewProject}
          onOpenFolder={handleOpenFolder}
          onOpenFile={handleOpenFile}
          onOpenRecent={handleOpenRecent}
          onClearRecent={handleClearRecent}
        />
        {tabs.length > 0 && (
          <TabBar
            tabs={tabs}
            activeId={activeTabId ?? ''}
            onSelect={setActiveTabId}
            onClose={closeTab}
            onTogglePin={togglePin}
          />
        )}
        <div className="content-area">
          {activeDiffTab ? (
            <div className="pane">
              <DiffView
                result={activeDiffTab.result}
                loading={activeDiffTab.loading}
                sideBySide={sideBySide}
                onToggleSideBySide={() => setSideBySide((v) => !v)}
              />
            </div>
          ) : null}
        </div>
      </main>

      {/* diff 表示中のみリサイズハンドルと右パネルを分離表示 */}
      {activeDiffTab && (
        <div
          className="resize-handle"
          onMouseDown={handleResizeStart}
          title="ドラッグで Claude Code パネルの幅を調整"
          role="separator"
          aria-orientation="vertical"
        />
      )}
      <aside className={`claude-code-panel${activeDiffTab ? '' : ' claude-code-panel--full'}`}>
        <header className="claude-code-panel__header">
          <div className="claude-code-panel__title-wrap">
            <AppMenu
              recentProjects={settings.recentProjects ?? []}
              onNewProject={handleNewProject}
              onOpenFolder={handleOpenFolder}
              onOpenFile={handleOpenFile}
              onOpenRecent={handleOpenRecent}
              onClearRecent={handleClearRecent}
            />
            <span className="claude-code-panel__dot" />
            <span className="claude-code-panel__title">{t('claudePanel.title')}</span>
          </div>
          <div className="claude-code-panel__header-right">
            <button
              type="button"
              className="toolbar__btn toolbar__btn--icon"
              onClick={() => setPaletteOpen(true)}
              title={t('toolbar.palette.title')}
            >
              <CommandIcon size={16} strokeWidth={1.75} />
            </button>
            <button
              type="button"
              className="toolbar__btn toolbar__btn--icon"
              onClick={() => setSettingsOpen(true)}
              title={t('toolbar.settings.title')}
            >
              <SettingsIcon size={16} strokeWidth={1.75} />
            </button>
            <div className="toolbar__divider" />
            {/* + ボタン & 作成メニュー */}
            <div style={{ position: 'relative' }}>
              <button
                type="button"
                className="claude-code-panel__add-btn"
                onClick={() => setTabCreateMenuOpen((v) => !v)}
                disabled={terminalTabs.length >= MAX_TERMINALS}
                title={t('claudePanel.newTab')}
              >
                <Plus size={16} strokeWidth={2} />
              </button>
              {tabCreateMenuOpen && (
                <>
                  <div
                    style={{ position: 'fixed', inset: 0, zIndex: 499 }}
                    onClick={() => setTabCreateMenuOpen(false)}
                  />
                  <div className="tab-create-menu" style={{ top: '100%', bottom: 'auto', right: 0, marginTop: 4 }}>
                    <button
                      className="tab-create-menu__item"
                      onClick={() => { addTerminalTab({ agent: 'claude' }); setTabCreateMenuOpen(false); }}
                    >
                      <span className="terminal-tab__agent terminal-tab__agent--claude">C</span>
                      {t('claudePanel.addClaude')}
                    </button>
                    <button
                      className="tab-create-menu__item"
                      onClick={() => { addTerminalTab({ agent: 'codex' }); setTabCreateMenuOpen(false); }}
                    >
                      <span className="terminal-tab__agent terminal-tab__agent--codex">X</span>
                      {t('claudePanel.addCodex')}
                    </button>
                    <div className="tab-create-menu__divider" />
                    <button
                      className="tab-create-menu__item"
                      onClick={() => { setTeamModalOpen(true); setTabCreateMenuOpen(false); }}
                    >
                      <Users size={14} />
                      {t('claudePanel.createTeam')}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        {/* Leader 閉じ確認ダイアログ */}
        {pendingTeamClose && (
          <div className="team-close-confirm">
            <p>{t('team.closeTeamConfirm')}</p>
            <div className="team-close-confirm__actions">
              <button className="toolbar__btn toolbar__btn--primary" onClick={() => { doCloseTeam(pendingTeamClose.teamId); setPendingTeamClose(null); }}>
                {t('team.closeTeam')}
              </button>
              <button className="toolbar__btn" onClick={() => { doCloseTab(pendingTeamClose.tabId); setTerminalTabs((prev) => prev.map((t) => t.teamId === pendingTeamClose.teamId ? { ...t, teamId: null } : t)); setTeams((prev) => prev.filter((t) => t.id !== pendingTeamClose.teamId)); setPendingTeamClose(null); }}>
                {t('team.closeLeaderOnly')}
              </button>
              <button className="toolbar__btn" onClick={() => setPendingTeamClose(null)}>
                {t('settings.cancel')}
              </button>
            </div>
          </div>
        )}

        {/* 分割ペイン表示 */}
        <div
          className="claude-code-panel__body"
          data-panes={terminalTabs.length}
        >
          {claudeCheck.state === 'checking' && (
            <div className="claude-not-found__body" style={{ padding: 40, textAlign: 'center' }}>
              {t('claudePanel.checking')}
            </div>
          )}
          {claudeCheck.state === 'missing' && (
            <ClaudeNotFound
              error={claudeCheck.error}
              onRetry={() => void runClaudeCheck()}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          )}
          {claudeCheck.state === 'ok' &&
            projectRoot &&
            terminalTabs.map((tab) => (
              <div
                key={`pane-${tab.id}`}
                className={`terminal-pane${tab.id === activeTerminalTabId ? ' is-active' : ''}${dragOverTabId === tab.id && dragTabId !== tab.id ? ' drag-over' : ''}`}
                onClick={() => setActiveTerminalTabId(tab.id)}
              >
                {/* ペインヘッダー（エージェント + ロール + 閉じる） */}
                {terminalTabs.length > 1 && (
                  <div
                    className="terminal-pane__header"
                    draggable
                    onDragStart={(e) => {
                      setDragTabId(tab.id);
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                      setDragOverTabId(tab.id);
                    }}
                    onDragLeave={() => {
                      if (dragOverTabId === tab.id) setDragOverTabId(null);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragTabId !== null && dragTabId !== tab.id) {
                        setTerminalTabs((prev) => {
                          const fromIdx = prev.findIndex((t) => t.id === dragTabId);
                          const toIdx = prev.findIndex((t) => t.id === tab.id);
                          if (fromIdx === -1 || toIdx === -1) return prev;
                          const next = [...prev];
                          const [moved] = next.splice(fromIdx, 1);
                          next.splice(toIdx, 0, moved);
                          return next;
                        });
                      }
                      setDragTabId(null);
                      setDragOverTabId(null);
                    }}
                    onDragEnd={() => {
                      setDragTabId(null);
                      setDragOverTabId(null);
                    }}
                  >
                    <span className={`terminal-tab__agent terminal-tab__agent--${tab.agent}`}>
                      {tab.agent === 'claude' ? 'C' : 'X'}
                    </span>
                    {tab.role === 'leader' && (
                      <Crown size={10} strokeWidth={2.5} className="terminal-tab__leader-icon" />
                    )}
                    {tab.role && (
                      <span className={`terminal-tab__role terminal-tab__role--${tab.role}`}>
                        {tab.role}
                      </span>
                    )}
                    {tab.teamId && (
                      <span className="terminal-pane__team-name">
                        {teams.find((t) => t.id === tab.teamId)?.name}
                      </span>
                    )}
                    <span style={{ flex: 1 }} />
                    <button
                      className="terminal-pane__close"
                      onClick={(e) => { e.stopPropagation(); closeTerminalTab(tab.id); }}
                    >
                      &times;
                    </button>
                  </div>
                )}
                <TerminalView
                  key={`term-${tab.id}-v${tab.version}`}
                  ref={(el) => {
                    if (el) terminalRefs.current.set(tab.id, el);
                    else terminalRefs.current.delete(tab.id);
                  }}
                  cwd={settings.claudeCwd || projectRoot}
                  command={
                    tab.agent === 'codex'
                      ? settings.codexCommand || 'codex'
                      : settings.claudeCommand || 'claude'
                  }
                  args={getTerminalArgs(tab)}
                  env={getTerminalEnv(tab)}
                  visible={true}
                  initialMessage={getRolePrompt(tab)}
                  onStatus={(s) =>
                    setTerminalTabs((prev) =>
                      prev.map((t) => (t.id === tab.id ? { ...t, status: s } : t))
                    )
                  }
                  onExit={() =>
                    setTerminalTabs((prev) =>
                      prev.map((t) => (t.id === tab.id ? { ...t, exited: true } : t))
                    )
                  }
                />
              </div>
            ))}
        </div>
      </aside>

      <SettingsModal
        open={settingsOpen}
        initial={settings}
        onClose={() => setSettingsOpen(false)}
        onApply={(next) => {
          void updateSettings(next);
        }}
        onReset={() => {
          void resetSettings();
        }}
      />

      <CommandPalette
        open={paletteOpen}
        commands={commands}
        onClose={() => setPaletteOpen(false)}
      />

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}

      <TeamCreateModal
        open={teamModalOpen}
        onClose={() => setTeamModalOpen(false)}
        onCreate={handleCreateTeam}
        savedPresets={settings.teamPresets ?? []}
        onSavePreset={handleSavePreset}
        onDeletePreset={handleDeletePreset}
        maxTerminals={MAX_TERMINALS}
        currentTabCount={terminalTabs.length}
        existingTeams={teams}
      />
    </div>
  );
}

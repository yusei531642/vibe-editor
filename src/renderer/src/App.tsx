import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RotateCw } from 'lucide-react';
import type {
  GitDiffResult,
  GitFileChange,
  GitStatus,
  SessionInfo,
  ThemeName
} from '../../types/shared';
import { Sidebar, type SidebarView } from './components/Sidebar';
import { TabBar, type TabItem } from './components/TabBar';
import { Toolbar } from './components/Toolbar';
import { DiffView } from './components/DiffView';
import { TerminalView, type TerminalViewHandle } from './components/TerminalView';
import { SettingsModal } from './components/SettingsModal';
import { CommandPalette } from './components/CommandPalette';
import { WelcomePane } from './components/WelcomePane';
import { ContextMenu, type ContextMenuItem } from './components/ContextMenu';
import { ClaudeNotFound } from './components/ClaudeNotFound';
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

  // Claude Code terminal
  const [terminalStatus, setTerminalStatus] = useState<string>('');
  const [terminalExited, setTerminalExited] = useState<boolean>(false);
  const [terminalVersion, setTerminalVersion] = useState<number>(0);
  const [resumeSessionId, setResumeSessionId] = useState<string | null>(null);
  const terminalRef = useRef<TerminalViewHandle | null>(null);

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

  const restartTerminal = useCallback(() => {
    setTerminalExited(false);
    setTerminalStatus('');
    setTerminalVersion((v) => v + 1);
  }, []);

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

        setGitStatus(gs);
        setSessions(sess);
        // タブ・セッション状態をリセット
        setDiffTabs([]);
        setRecentlyClosed([]);
        setActiveTabId(null);
        setResumeSessionId(null);
        setActiveSessionId(null);
        // ターミナル再起動
        setTerminalExited(false);
        setTerminalStatus('起動中…');
        setTerminalVersion((v) => v + 1);
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
    const name = projectRoot.split(/[\\/]/).pop() || 'claude-editor';
    window.api.app.setWindowTitle(`claude-editor — ${name}`).catch(() => undefined);
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
      // プロンプト文言は UI 言語に合わせる（Claude はどちらでも読める）
      const prompt =
        settings.language === 'en'
          ? `Please review the changes in this file and point out any issues or possible improvements: ${file.path}`
          : `このファイルの変更内容をレビューしてください。問題点や改善の余地があれば指摘してください: ${file.path}`;
      const term = terminalRef.current;
      if (!term) {
        showToast(t('toast.terminalNotReady'), { tone: 'warning' });
        return;
      }
      term.sendCommand(prompt, true);
      showToast(t('toast.reviewRequested', { path: file.path }), { tone: 'info' });
      term.focus();
    },
    [showToast, settings.language, t]
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
      setResumeSessionId(session.id);
      setActiveSessionId(session.id);
      setTerminalStatus(`セッション ${session.id.slice(0, 8)} に復帰中…`);
      showToast(`セッションに復帰: ${session.title.slice(0, 40)}`, { tone: 'info' });
      setTerminalVersion((v) => v + 1);
      setTerminalExited(false);
    },
    [showToast]
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
        run: () => activeTabId && closeTab(activeTabId)
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
        run: () => activeTabId && togglePin(activeTabId)
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
        id: 'terminal.newSession',
        title: '新しい Claude Code セッションを開始',
        category: 'ターミナル',
        run: () => {
          setResumeSessionId(null);
          setActiveSessionId(null);
          restartTerminal();
        }
      },
      {
        id: 'terminal.restart',
        title: 'Claude Code ターミナルを再起動',
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
        title: 'claude-editor (アプリ) を再起動',
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
    diffTabs.length
  ]);

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

  const effectiveTerminalArgs = useMemo(() => {
    const base = parseShellArgs(settings.claudeArgs || '');
    if (resumeSessionId) return [...base, '--resume', resumeSessionId];
    return base;
  }, [settings.claudeArgs, resumeSessionId]);

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

  return (
    <div className="layout">
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
          ) : (
            <div className="pane">
              <WelcomePane projectName={projectName} />
            </div>
          )}
        </div>
      </main>

      <div
        className="resize-handle"
        onMouseDown={handleResizeStart}
        title="ドラッグで Claude Code パネルの幅を調整"
        role="separator"
        aria-orientation="vertical"
      />
      <aside className="claude-code-panel">
        <header className="claude-code-panel__header">
          <div className="claude-code-panel__title-wrap">
            <span
              className="claude-code-panel__dot"
              style={{
                background:
                  claudeCheck.state === 'missing' ? 'var(--warning)' : 'var(--accent)'
              }}
            />
            <span className="claude-code-panel__title">{t('claudePanel.title')}</span>
            {resumeSessionId && (
              <span className="claude-code-panel__resume">
                {resumeSessionId.slice(0, 8)}
              </span>
            )}
          </div>
          <div className="claude-code-panel__header-right">
            <span
              className={`claude-code-panel__status ${terminalExited || claudeCheck.state === 'missing' ? 'is-exited' : 'is-running'}`}
            >
              {claudeCheck.state === 'missing'
                ? t('claudePanel.notFound.title')
                : claudeCheck.state === 'checking'
                  ? t('claudePanel.checking')
                  : terminalExited
                    ? t('claudePanel.exited')
                    : terminalStatus || t('claudePanel.starting')}
            </span>
            <button
              type="button"
              className="claude-code-panel__restart"
              onClick={restartTerminal}
              title={t('claudePanel.restartTitle')}
              aria-label={t('claudePanel.restartTitle')}
            >
              <RotateCw size={14} strokeWidth={2} />
            </button>
          </div>
        </header>
        <div className="claude-code-panel__body">
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
          {claudeCheck.state === 'ok' && projectRoot && (
            <TerminalView
              key={terminalVersion}
              ref={terminalRef}
              cwd={settings.claudeCwd || projectRoot}
              command={settings.claudeCommand || 'claude'}
              args={effectiveTerminalArgs}
              visible={true}
              onStatus={setTerminalStatus}
              onExit={() => setTerminalExited(true)}
            />
          )}
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
    </div>
  );
}

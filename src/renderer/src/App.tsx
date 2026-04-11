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
import { ClaudeMdEditor } from './components/ClaudeMdEditor';
import { DiffView } from './components/DiffView';
import { TerminalView } from './components/TerminalView';
import { SettingsModal } from './components/SettingsModal';
import { CommandPalette } from './components/CommandPalette';
import { claudeMdTemplate } from './lib/template';
import { useSettings } from './lib/settings-context';
import { useToast } from './lib/toast-context';
import { parseShellArgs } from './lib/parse-args';
import type { Command } from './lib/commands';

const CLAUDE_MD_TAB_ID = 'claude-md';
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
  const [projectRoot, setProjectRoot] = useState<string>('');
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [paletteOpen, setPaletteOpen] = useState<boolean>(false);

  // CLAUDE.md
  const [claudeMdPath, setClaudeMdPath] = useState<string | null>(null);
  const [claudeMdExists, setClaudeMdExists] = useState<boolean>(false);
  const [content, setContent] = useState<string>('');
  const [savedContent, setSavedContent] = useState<string>('');
  const [saving, setSaving] = useState<boolean>(false);
  const [status, setStatus] = useState<string>('');
  const [savePulse, setSavePulse] = useState<boolean>(false);

  // sidebar
  const [sidebarView, setSidebarView] = useState<SidebarView>('changes');

  // git (changes view)
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [gitLoading, setGitLoading] = useState<boolean>(true);

  // sessions view
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState<boolean>(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  // tabs
  const [activeTabId, setActiveTabId] = useState<string>(CLAUDE_MD_TAB_ID);
  const [diffTabs, setDiffTabs] = useState<DiffTab[]>([]);
  const [recentlyClosed, setRecentlyClosed] = useState<DiffTab[]>([]);
  const [sideBySide, setSideBySide] = useState<boolean>(true);

  // Claude Code terminal
  const [terminalStatus, setTerminalStatus] = useState<string>('起動待ち');
  const [terminalExited, setTerminalExited] = useState<boolean>(false);
  const [terminalVersion, setTerminalVersion] = useState<number>(0);
  const [resumeSessionId, setResumeSessionId] = useState<string | null>(null);

  // 自動保存タイマー
  const autoSaveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const restartTerminal = useCallback(() => {
    setTerminalExited(false);
    setTerminalStatus('再起動中…');
    setTerminalVersion((v) => v + 1);
  }, []);

  /**
   * 指定されたルートでプロジェクトを読み直す。初回も切替時も共通で使う。
   * - CLAUDE.md / git / sessions を並列取得
   * - タブ・resume 状態をリセット
   * - ターミナルを新しい cwd で再起動
   * - recentProjects に追加
   */
  const loadProject = useCallback(
    async (root: string, options: { addToRecent?: boolean } = { addToRecent: true }) => {
      setProjectRoot(root);
      setStatus('プロジェクト読み込み中…');
      setGitLoading(true);

      try {
        const [md, gs, sess] = await Promise.all([
          window.api.claudeMd.find(root),
          window.api.git.status(root),
          window.api.sessions.list(root)
        ]);

        setClaudeMdPath(md.path);
        setClaudeMdExists(md.exists);
        const initial = md.content ?? '';
        setContent(initial);
        setSavedContent(initial);
        setGitStatus(gs);
        setSessions(sess);
        // タブ・セッション状態をリセット
        setDiffTabs([]);
        setRecentlyClosed([]);
        setActiveTabId(CLAUDE_MD_TAB_ID);
        setResumeSessionId(null);
        setActiveSessionId(null);
        // ターミナル再起動
        setTerminalExited(false);
        setTerminalStatus('起動中…');
        setTerminalVersion((v) => v + 1);
        setStatus(
          md.exists
            ? `プロジェクトを開きました: ${root}`
            : 'CLAUDE.md がありません — Claude Code に作成依頼できます'
        );
        // 最近のプロジェクトに追加
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

  // 初回ロード: 起動引数やcwdからプロジェクトを決定
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const root = await window.api.app.getProjectRoot();
        if (cancelled) return;
        // 初回は loadProject を使わず直接読み込み（初期化時の state 依存ループを避ける）
        setProjectRoot(root);
        const [md, gs, sess] = await Promise.all([
          window.api.claudeMd.find(root),
          window.api.git.status(root),
          window.api.sessions.list(root)
        ]);
        if (cancelled) return;
        setClaudeMdPath(md.path);
        setClaudeMdExists(md.exists);
        const initial = md.content ?? '';
        setContent(initial);
        setSavedContent(initial);
        setGitStatus(gs);
        setGitLoading(false);
        setSessions(sess);
        setStatus(
          md.exists
            ? '読み込み完了'
            : 'CLAUDE.md がありません — Claude Code に作成依頼できます'
        );
      } catch (err) {
        setStatus(`初期化エラー: ${String(err)}`);
        setGitLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = content !== savedContent;

  // タイトルバーに反映
  useEffect(() => {
    const label = claudeMdExists ? 'CLAUDE.md' : 'CLAUDE.md (新規)';
    const dirtyMark = dirty ? ' ●' : '';
    const title = `claude-editor — ${label}${dirtyMark}`;
    window.api.app.setWindowTitle(title).catch(() => undefined);
  }, [dirty, claudeMdExists]);

  // ---------- CLAUDE.md 保存 ----------

  const handleSave = useCallback(async () => {
    if (!claudeMdPath) return;
    setSaving(true);
    setStatus('保存中…');
    try {
      const res = await window.api.claudeMd.save(claudeMdPath, content);
      if (res.ok) {
        setSavedContent(content);
        setClaudeMdExists(true);
        setStatus(`保存しました (${new Date().toLocaleTimeString()})`);
        setSavePulse(true);
        setTimeout(() => setSavePulse(false), 600);
      } else {
        setStatus(`保存失敗: ${res.error ?? '不明なエラー'}`);
        showToast(`保存失敗: ${res.error ?? ''}`, { tone: 'error' });
      }
    } finally {
      setSaving(false);
    }
  }, [claudeMdPath, content, showToast]);

  // 自動保存
  useEffect(() => {
    if (autoSaveTimerRef.current) {
      clearInterval(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    if (settings.autoSave && claudeMdPath) {
      autoSaveTimerRef.current = setInterval(() => {
        setSavedContent((savedContentCurrent) => {
          setContent((contentCurrent) => {
            if (contentCurrent !== savedContentCurrent) {
              window.api.claudeMd
                .save(claudeMdPath, contentCurrent)
                .then((res) => {
                  if (res.ok) {
                    setSavedContent(contentCurrent);
                    setStatus(`自動保存 (${new Date().toLocaleTimeString()})`);
                  }
                })
                .catch(() => undefined);
            }
            return contentCurrent;
          });
          return savedContentCurrent;
        });
      }, settings.autoSaveIntervalMs);
    }
    return () => {
      if (autoSaveTimerRef.current) clearInterval(autoSaveTimerRef.current);
    };
  }, [settings.autoSave, settings.autoSaveIntervalMs, claudeMdPath]);

  // ---------- テンプレート挿入（読み取り限定だが念のため残す） ----------

  const handleInsertTemplate = useCallback(() => {
    const before = content;
    const name = projectRoot.split(/[\\/]/).pop() || 'my-project';
    setContent(claudeMdTemplate(name));
    setStatus('テンプレートを挿入しました（まだ保存されていません）');
    showToast('テンプレートを挿入しました', {
      action: {
        label: '元に戻す',
        onClick: () => {
          setContent(before);
          setStatus('テンプレート挿入を取り消しました');
        }
      },
      duration: 6000
    });
  }, [projectRoot, content, showToast]);

  const handleRestart = useCallback(async () => {
    if (dirty && !window.confirm('未保存の変更があります。保存せずに再起動しますか？')) {
      return;
    }
    await window.api.app.restart();
  }, [dirty]);

  // ---------- プロジェクトメニュー操作 ----------

  const handleNewProject = useCallback(async () => {
    const folder = await window.api.dialog.openFolder('新規プロジェクト: 空フォルダを選択/作成');
    if (!folder) return;
    const empty = await window.api.dialog.isFolderEmpty(folder);
    if (!empty) {
      showToast(
        `フォルダが空ではありません。既存プロジェクトとして開きます`,
        { tone: 'warning' }
      );
    } else {
      showToast(`新規プロジェクトを作成: ${folder}`, { tone: 'success' });
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
    // ファイルの親ディレクトリをプロジェクトとして開く
    const parent = file.replace(/[\\/][^\\/]+$/, '');
    await loadProject(parent);
    showToast(`${file} を開きました。親フォルダをプロジェクトとして読み込んでいます`, {
      tone: 'info'
    });
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

  // 履歴ビューに切り替わったら最新を取得
  useEffect(() => {
    if (sidebarView === 'sessions') {
      void refreshSessions();
    }
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

  // ---------- セッション復帰 ----------

  const handleResumeSession = useCallback(
    (session: SessionInfo) => {
      setResumeSessionId(session.id);
      setActiveSessionId(session.id);
      setTerminalStatus(`セッション ${session.id.slice(0, 8)} に復帰中…`);
      showToast(`セッション ${session.title.slice(0, 40)} に復帰`, { tone: 'info' });
      setTerminalVersion((v) => v + 1);
      setTerminalExited(false);
    },
    [showToast]
  );

  // ---------- タブ操作 ----------

  const closeTab = useCallback(
    (id: string) => {
      if (id === CLAUDE_MD_TAB_ID) return;
      setDiffTabs((prev) => {
        const target = prev.find((t) => t.id === id);
        if (!target || target.pinned) return prev;
        setRecentlyClosed((rc) =>
          [target, ...rc.filter((r) => r.id !== id)].slice(0, 10)
        );
        const next = prev.filter((t) => t.id !== id);
        if (activeTabId === id) {
          const fallback = next.length > 0 ? next[next.length - 1].id : CLAUDE_MD_TAB_ID;
          setActiveTabId(fallback);
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
      const ids = [CLAUDE_MD_TAB_ID, ...diffTabs.map((t) => t.id)];
      const idx = ids.indexOf(activeTabId);
      if (idx < 0) return;
      const next = (idx + direction + ids.length) % ids.length;
      setActiveTabId(ids[next]);
    },
    [activeTabId, diffTabs]
  );

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
      ...((settings.recentProjects ?? []).slice(0, 5).map<Command>((p) => ({
        id: `project.recent.${p}`,
        title: `最近: ${p.split(/[\\/]/).pop()}`,
        subtitle: p,
        category: 'プロジェクト',
        run: () => void handleOpenRecent(p)
      }))),
      {
        id: 'file.save',
        title: 'CLAUDE.md を保存',
        subtitle: 'Ctrl+S',
        category: 'ファイル',
        when: () => dirty && !!claudeMdPath,
        run: () => void handleSave()
      },
      {
        id: 'file.insertTemplate',
        title: 'テンプレートを挿入',
        category: 'ファイル',
        run: () => handleInsertTemplate()
      },
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
        id: 'view.claudeMd',
        title: 'CLAUDE.md タブへ',
        subtitle: 'Ctrl+1',
        category: 'ビュー',
        run: () => setActiveTabId(CLAUDE_MD_TAB_ID)
      },
      {
        id: 'view.nextTab',
        title: '次のタブへ',
        subtitle: 'Ctrl+Tab',
        category: 'ビュー',
        run: () => cycleTab(1)
      },
      {
        id: 'view.prevTab',
        title: '前のタブへ',
        subtitle: 'Ctrl+Shift+Tab',
        category: 'ビュー',
        run: () => cycleTab(-1)
      },
      {
        id: 'tab.close',
        title: 'アクティブなタブを閉じる',
        subtitle: 'Ctrl+W',
        category: 'タブ',
        when: () => activeTabId.startsWith('diff:'),
        run: () => closeTab(activeTabId)
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
        when: () => activeTabId.startsWith('diff:'),
        run: () => togglePin(activeTabId)
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
        id: 'settings.toggleAutoSave',
        title: `自動保存を${settings.autoSave ? '無効' : '有効'}にする`,
        category: '設定',
        run: () => void updateSettings({ autoSave: !settings.autoSave })
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
    dirty,
    claudeMdPath,
    handleSave,
    handleInsertTemplate,
    cycleTab,
    activeTabId,
    closeTab,
    recentlyClosed,
    reopenLastClosed,
    togglePin,
    refreshGit,
    refreshSessions,
    settings.theme,
    settings.autoSave,
    settings.density,
    settings.recentProjects,
    updateSettings,
    handleRestart,
    restartTerminal,
    handleNewProject,
    handleOpenFolder,
    handleOpenFile,
    handleOpenRecent
  ]);

  // ---------- グローバルキーボードショートカット ----------

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
      if (e.key === 's' || e.key === 'S') {
        if (activeTabId === CLAUDE_MD_TAB_ID) {
          e.preventDefault();
          void handleSave();
        }
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        cycleTab(e.shiftKey ? -1 : 1);
        return;
      }
      if (e.key === 'w' || e.key === 'W') {
        e.preventDefault();
        e.stopPropagation();
        closeTab(activeTabId);
        return;
      }
      if (e.shiftKey && (e.key === 'T' || e.key === 't')) {
        e.preventDefault();
        reopenLastClosed();
        return;
      }
      if (e.key === '1') {
        e.preventDefault();
        setActiveTabId(CLAUDE_MD_TAB_ID);
        return;
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [
    paletteOpen,
    settingsOpen,
    activeTabId,
    handleSave,
    cycleTab,
    closeTab,
    reopenLastClosed
  ]);

  // ---------- 起動引数の合成 (resume が指定されていれば --resume <id> を追加) ----------

  const effectiveTerminalArgs = useMemo(() => {
    const base = parseShellArgs(settings.claudeArgs || '');
    if (resumeSessionId) return [...base, '--resume', resumeSessionId];
    return base;
  }, [settings.claudeArgs, resumeSessionId]);

  // ---------- タブリスト ----------

  const tabs: TabItem[] = [
    {
      id: CLAUDE_MD_TAB_ID,
      title: claudeMdExists ? 'CLAUDE.md' : 'CLAUDE.md (新規)',
      dirty,
      closable: false
    },
    ...diffTabs.map((t) => ({
      id: t.id,
      title: t.relPath.split('/').pop() ?? t.relPath,
      closable: true as const,
      pinned: t.pinned
    }))
  ];

  const activeDiffTab = diffTabs.find((t) => t.id === activeTabId) ?? null;
  const activeDiffPath = activeDiffTab?.relPath ?? null;

  const toolbarFilePath =
    activeTabId === CLAUDE_MD_TAB_ID
      ? claudeMdPath
      : (activeDiffTab?.relPath ?? null);

  return (
    <div className="layout">
      <Sidebar
        view={sidebarView}
        onViewChange={setSidebarView}
        gitStatus={gitStatus}
        gitLoading={gitLoading}
        onRefreshGit={refreshGit}
        onOpenDiff={openDiffTab}
        activeDiffPath={activeDiffPath}
        sessions={sessions}
        sessionsLoading={sessionsLoading}
        activeSessionId={activeSessionId}
        onRefreshSessions={refreshSessions}
        onResumeSession={handleResumeSession}
      />
      <main className="main">
        <Toolbar
          filePath={toolbarFilePath}
          dirty={dirty}
          saving={saving}
          savePulse={savePulse}
          onSave={handleSave}
          onInsertTemplate={handleInsertTemplate}
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
        <TabBar
          tabs={tabs}
          activeId={activeTabId}
          onSelect={setActiveTabId}
          onClose={closeTab}
          onTogglePin={togglePin}
        />
        <div className="content-area">
          <div
            className="pane"
            style={{ display: activeTabId === CLAUDE_MD_TAB_ID ? 'flex' : 'none' }}
          >
            <ClaudeMdEditor
              value={content}
              originalValue={savedContent}
              onChange={setContent}
              onSaveShortcut={handleSave}
            />
          </div>

          {activeDiffTab && activeTabId === activeDiffTab.id && (
            <div className="pane">
              <DiffView
                result={activeDiffTab.result}
                loading={activeDiffTab.loading}
                sideBySide={sideBySide}
                onToggleSideBySide={() => setSideBySide((v) => !v)}
              />
            </div>
          )}
        </div>
      </main>

      <aside className="claude-code-panel">
        <header className="claude-code-panel__header">
          <div className="claude-code-panel__title-wrap">
            <span className="claude-code-panel__dot" />
            <span className="claude-code-panel__title">Claude Code</span>
            {resumeSessionId && (
              <span className="claude-code-panel__resume">
                {resumeSessionId.slice(0, 8)}
              </span>
            )}
          </div>
          <div className="claude-code-panel__header-right">
            <span
              className={`claude-code-panel__status ${terminalExited ? 'is-exited' : 'is-running'}`}
            >
              {terminalExited ? '終了' : terminalStatus || '起動中'}
            </span>
            <button
              type="button"
              className="claude-code-panel__restart"
              onClick={restartTerminal}
              title="ターミナルを再起動"
              aria-label="再起動"
            >
              <RotateCw size={14} strokeWidth={2} />
            </button>
          </div>
        </header>
        <div className="claude-code-panel__body">
          {projectRoot && (
            <TerminalView
              key={terminalVersion}
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
    </div>
  );
}

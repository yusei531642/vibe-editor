/**
 * AppShell — IDE モードの画面本体 (Issue #731)。
 *
 * 旧 App.tsx (1136 行) は「hook 統合層 + ref ブリッジ 5 連発 + 巨大 JSX」が
 * 同居する god component だった。Issue #731 で:
 *   - hook 統合層と ref ブリッジ → `AppStateProvider` (lib/app-state-context.tsx)
 *   - 画面本体 (JSX + 画面ローカル state / derived / handler) → 本ファイル
 * に分離し、App.tsx は Provider tree だけにした。
 *
 * 本コンポーネントは `useProject()` / `useTabs()` / `useTeam()` の 3 つの consumer
 * hook で必要な slice だけを購読する (callbacks-down / events-up)。ここに残るのは
 * **画面に固有のローカル state** だけ:
 *   - sidebarView / contextMenu / sideBySide
 *   - sessions / sessionsLoading / activeSessionId (セッションパネル UI)
 *   - mascot / commands などの派生値
 *   - <TerminalView> ref Map (JSX 配線が App 側に残るため hook 化対象外)
 *
 * 振る舞いは旧 App.tsx と完全一致 (純粋リファクタ)。state 宣言順・effect・
 * useMemo deps・JSX 構造はすべて旧コードを保持している。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from 'react';
import {
  Command as CommandIcon,
  Crown,
  Plus,
  RotateCw,
  Settings as SettingsIcon
} from 'lucide-react';
import type { GitFileChange, SessionInfo } from '../../../types/shared';
import { Sidebar, type SidebarView } from './Sidebar';
import { TabBar, type TabItem } from './TabBar';
import { Topbar } from './shell/Topbar';
import { Rail } from './shell/Rail';
import { StatusBar } from './shell/StatusBar';
import { DiffView } from './DiffView';
import { EditorView } from './EditorView';
import { TerminalView, type TerminalViewHandle } from './TerminalView';
import { SettingsModal } from './SettingsModal';
import { CommandPalette } from './CommandPalette';
import { OnboardingWizard } from './OnboardingWizard';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { AppMenuBar } from './shell/AppMenuBar';
import { useRecruitListener } from '../lib/use-recruit-listener';
import { useCanvasVisibility } from '../lib/use-canvas-visibility';
import { ClaudeNotFound } from './ClaudeNotFound';
import { getStatusMascotState } from '../lib/status-mascot';
import { useMascotOrchestrator } from '../lib/hooks/use-mascot-orchestrator';
import { useT } from '../lib/i18n';
import {
  useSettingsActions,
  useSettingsLoading
} from '../lib/settings-context';
import { useToast } from '../lib/toast-context';
import { useUiStore } from '../stores/ui';
import { useAppShellState } from '../lib/hooks/use-app-shell-state';
import { MAX_TERMINALS, getRoleDisplayLabel } from '../lib/hooks/use-terminal-tabs';
import { useLayoutResize } from '../lib/hooks/use-layout-resize';
import { useAppShortcuts } from '../lib/hooks/use-app-shortcuts';
import type { Command } from '../lib/commands';
import { buildAppCommands } from '../lib/app-commands';
import {
  canRenderTerminalForAgent,
  shouldShowGlobalClaudeCheck
} from '../lib/terminal-render-gate';
import { useProject, useTabs, useTeam } from '../lib/app-state-context';

export interface AppShellProps {
  /**
   * セッションパネル UI の state。App が保持し AppStateProvider の
   * `onSessionsLoaded` / `onProjectSwitched` (events-up) と整合させるため
   * props 経由で受け取る (Issue #731)。旧 App.tsx では同コンポーネント内の
   * useState だった。
   */
  sessions: SessionInfo[];
  setSessions: Dispatch<SetStateAction<SessionInfo[]>>;
  /**
   * 現在復帰中のセッション id。プロジェクト切替時に AppStateProvider の
   * `onProjectSwitched` callback (App 経由) で null にリセットされる。
   */
  activeSessionId: string | null;
  setActiveSessionId: Dispatch<SetStateAction<string | null>>;
}

export function AppShell({
  sessions,
  setSessions,
  activeSessionId,
  setActiveSessionId
}: AppShellProps): JSX.Element {
  const settingsLoading = useSettingsLoading();
  const { update: updateSettings, reset: resetSettings } = useSettingsActions();
  // Phase 2 (Issue #487): App.tsx 冒頭の `useSettingsValue` 17 連発合成は
  // `useAppShellState` hook に外出し済み。再描画粒度は変えていない。
  const settings = useAppShellState();
  const { showToast, dismissToast } = useToast();
  const t = useT();
  const viewMode = useUiStore((s) => s.viewMode);
  // Phase 1-8 (Issue #373): UI 系 state は useUiStore に集約。
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const paletteOpen = useUiStore((s) => s.paletteOpen);
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);
  const status = useUiStore((s) => s.status);

  // sidebar
  const [sidebarView, setSidebarView] = useState<SidebarView>('changes');

  // ---- Issue #731: hook 統合層は AppStateProvider に移管。3 slice を購読する ----
  const {
    projectRoot,
    refreshGit,
    gitStatus,
    gitLoading,
    workspaceFolders,
    handleNewProject,
    handleOpenFolder,
    handleOpenFile,
    handleOpenRecent,
    handleAddWorkspaceFolder,
    handleRemoveWorkspaceFolder
  } = useProject();

  const {
    editorTabs,
    diffTabs,
    recentlyClosed,
    activeTabId,
    setActiveTabId,
    dirtyEditorTabs,
    recentFiles,
    openEditorTab,
    updateEditorContent,
    saveEditorTab,
    openDiffTab,
    closeTab,
    togglePin,
    reopenLastClosed,
    cycleTab
  } = useTabs();

  const {
    terminalTabs,
    setTerminalTabs,
    activeTerminalTabId,
    setActiveTerminalTabId,
    activeTerminalIds,
    markTerminalActivity,
    addTerminalTab,
    closeTerminalTab,
    restartTerminalTab,
    restartTerminal,
    tabCreateMenuOpen,
    setTabCreateMenuOpen,
    pendingTeamClose,
    setPendingTeamClose,
    dragTabId,
    dragOverTabId,
    getDnDProps,
    editingLabelTabId,
    setEditingLabelTabId,
    markSessionPersisted,
    teams,
    teamHistoryEntries,
    doCloseTeam,
    handleCloseLeaderOnly,
    handleResumeTeam,
    handleDeleteTeamHistory,
    handleTerminalSessionId,
    persistTerminalCustomLabel,
    getTerminalArgs,
    getCodexInstructions,
    getRolePrompt,
    getTerminalEnv,
    claudeCheck,
    runClaudeCheck,
    reportTerminalSize
  } = useTeam();

  // sessions (セッションパネル UI): sessions / setSessions / activeSessionId /
  // setActiveSessionId は App から props で受け取る (AppStateProvider の
  // onSessionsLoaded / onProjectSwitched と整合させるため。Issue #731)。
  const [sessionsLoading, setSessionsLoading] = useState<boolean>(false);

  // tabs (editor / diff / recentlyClosed) は useFileTabs で集中管理する。
  const [sideBySide, setSideBySide] = useState<boolean>(true);

  // <TerminalView> ref は hook 化対象外: TerminalView の JSX 配線が App 側に残るため。
  const terminalRefs = useRef(new Map<number, TerminalViewHandle>());

  // コンテキストメニュー
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    items: ContextMenuItem[];
  } | null>(null);

  const handleRestart = useCallback(async () => {
    if (dirtyEditorTabs.length > 0) {
      // Issue #68: WebView の window.confirm ではなく Tauri ネイティブ dialog を使う。
      const { ask } = await import('@tauri-apps/plugin-dialog');
      const ok = await ask(t('editor.restartConfirm'), {
        title: 'vibe-editor',
        kind: 'warning'
      });
      if (!ok) return;
    }
    await window.api.app.restart();
  }, [dirtyEditorTabs.length, t]);

  // ---------- データ更新 ----------

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

  // ---------- 差分レビュー依頼 ----------

  /** 指定ファイルの変更を Claude Code にレビュー依頼するプロンプトを生成してターミナルに送信 */
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
      const isUntracked = file.indexStatus === '?' && file.worktreeStatus === '?';
      const items: ContextMenuItem[] = [];
      if (!isUntracked) {
        items.push(
          {
            label: t('ctxMenu.openDiff'),
            action: () => void openDiffTab(file)
          },
          {
            label: t('ctxMenu.reviewDiff'),
            action: () => reviewDiff(file),
            divider: true
          }
        );
      }
      items.push({
        label: t('ctxMenu.copyPath'),
        action: () => {
          void navigator.clipboard.writeText(file.path);
          showToast(t('toast.pathCopied'), { tone: 'info' });
        }
      });
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

  // Phase 1-9 (Issue #373): コマンドパレット用 Command[] 構築は lib/app-commands.ts に集約。
  const commands = useMemo<Command[]>(
    () =>
      buildAppCommands({
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
        diffTabsLength: diffTabs.length,
        recentlyClosedLength: recentlyClosed.length,
        refreshGit,
        refreshSessions,
        terminalTabsLength: terminalTabs.length,
        maxTerminals: MAX_TERMINALS,
        activeTerminalTabId,
        addTerminalTab,
        closeTerminalTab,
        restartTerminal,
        settings: {
          theme: settings.theme,
          density: settings.density,
          recentProjects: settings.recentProjects,
          language: settings.language
        },
        updateSettings,
        setSettingsOpen,
        handleRestart,
        showToast,
        dismissToast
      }),
    [
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
      diffTabs.length,
      recentlyClosed.length,
      refreshGit,
      refreshSessions,
      terminalTabs.length,
      activeTerminalTabId,
      addTerminalTab,
      closeTerminalTab,
      restartTerminal,
      settings.theme,
      settings.density,
      settings.recentProjects,
      settings.language,
      updateSettings,
      setSettingsOpen,
      handleRestart,
      showToast,
      dismissToast
    ]
  );

  // Phase 1-6 (Issue #373): グローバルショートカット + Shift+wheel zoom を hook に集約。
  useAppShortcuts({
    activeTabId,
    cycleTab,
    closeTab,
    reopenLastClosed,
    saveEditorTab
  });

  // Phase 1-5 (Issue #373): Claude Code パネル / サイドバーの drag リサイズと
  // CSS 変数同期は use-layout-resize.ts に集約。JSX のリサイズハンドルでのみ使う。
  const {
    onClaudePanelResizeStart,
    onSidebarResizeStart,
    onSidebarResizeDouble
  } = useLayoutResize();

  // ---------- タブリスト ----------

  const tabs: TabItem[] = [
    ...diffTabs.map((t) => ({
      id: t.id,
      title: t.relPath.split('/').pop() ?? t.relPath,
      closable: true as const,
      pinned: t.pinned
    })),
    ...editorTabs.map((t) => ({
      id: t.id,
      title: t.relPath.split('/').pop() ?? t.relPath,
      closable: true as const,
      pinned: t.pinned,
      dirty: t.content !== t.originalContent
    }))
  ];

  const activeDiffTab = diffTabs.find((t) => t.id === activeTabId) ?? null;
  const activeEditorTab = editorTabs.find((t) => t.id === activeTabId) ?? null;
  const activeDiffPath = activeDiffTab?.relPath ?? null;
  const activeFilePath = activeEditorTab?.relPath ?? null;
  const hasActiveContent = activeDiffTab !== null || activeEditorTab !== null;
  const baseMascotState = useMemo(
    () =>
      getStatusMascotState({
        viewMode,
        activeFilePath,
        activeEditorDirty: activeEditorTab
          ? activeEditorTab.content !== activeEditorTab.originalContent
          : false,
        hasActiveDiff: activeDiffTab !== null,
        gitChangeCount: gitStatus?.ok ? gitStatus.files.length : 0,
        terminals: terminalTabs.map((tab) => ({
          status: tab.status,
          exited: tab.exited,
          hasActivity: activeTerminalIds.has(tab.id)
        }))
      }),
    [
      activeDiffTab,
      activeEditorTab,
      activeFilePath,
      activeTerminalIds,
      gitStatus,
      terminalTabs,
      viewMode
    ]
  );
  const { state: mascotState, onMascotClick } = useMascotOrchestrator(baseMascotState);

  const gitChangeCount = gitStatus?.ok ? gitStatus.files.length : 0;
  // gitStatus が読み込み済みかつ ok=false のときだけ Rail から Changes タブを外す。
  const hasGitRepo = gitStatus === null ? true : gitStatus.ok;
  // git リポジトリでないと判明した瞬間に sidebar が 'changes' なら 'files' へ自動退避
  useEffect(() => {
    if (!hasGitRepo && sidebarView === 'changes') {
      setSidebarView('files');
    }
  }, [hasGitRepo, sidebarView]);
  // Issue #578: Canvas (Tauri webview) の可視状態を観測する singleton listener を mount。
  useCanvasVisibility();
  // Phase 6: vibe-canvas:recruit/dismiss イベントを listen して canvas store に反映
  useRecruitListener();
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const availableUpdate = useUiStore((s) => s.availableUpdate);

  // 「更新」ボタンクリック: 確認ダイアログ → DL → install → (Win 以外) relaunch。
  const handleClickUpdate = useCallback(() => {
    void import('../lib/updater-check').then((m) =>
      m.runUpdateInstall({
        language: settings.language,
        showToast,
        dismissToast,
        manual: true,
        runningTaskCount: terminalTabs.length
      })
    );
  }, [settings.language, showToast, dismissToast, terminalTabs.length]);

  // Ctrl+B (Cmd+B on macOS) で sidebar を toggle
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleSidebar]);

  return (
    <div
      className={
        `layout layout--redesign` +
        (hasActiveContent ? '' : ' layout--terminal-full') +
        (sidebarCollapsed ? ' layout--sidebar-collapsed' : '')
      }
    >
      <Topbar
        projectRoot={projectRoot}
        status={status}
        availableUpdate={availableUpdate}
        onClickUpdate={handleClickUpdate}
        mascotState={mascotState}
        onMascotClick={onMascotClick}
        menuBar={
          <AppMenuBar
            recentProjects={settings.recentProjects ?? []}
            onNewProject={() => void handleNewProject()}
            onOpenFolder={() => void handleOpenFolder()}
            onOpenFile={() => void handleOpenFile()}
            onAddWorkspaceFolder={() => void handleAddWorkspaceFolder()}
            onOpenRecent={(p) => handleOpenRecent(p)}
            onRestart={() => void handleRestart()}
            onCheckUpdate={() => {
              void import('../lib/updater-check').then((m) =>
                m.checkForUpdates({
                  language: settings.language,
                  showToast,
                  dismissToast,
                  manual: true,
                  runningTaskCount: terminalTabs.length
                })
              );
            }}
            onOpenGithub={() => {
              void window.api.app.openExternal('https://github.com/yusei531642/vibe-editor');
            }}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenPalette={() => setPaletteOpen(true)}
            onToggleSidebar={() => toggleSidebar()}
            onToggleCanvas={() => useUiStore.getState().toggleViewMode()}
          />
        }
      />
      <Rail
        sidebarView={sidebarView}
        onSidebarViewChange={setSidebarView}
        changeCount={gitChangeCount}
        onOpenSettings={() => setSettingsOpen(true)}
        hasGitRepo={hasGitRepo}
      />
      <Sidebar
        view={sidebarView}
        onViewChange={setSidebarView}
        projectRoot={projectRoot}
        workspaceFolders={workspaceFolders}
        onAddWorkspaceFolder={() => void handleAddWorkspaceFolder()}
        onRemoveWorkspaceFolder={handleRemoveWorkspaceFolder}
        activeFilePath={activeFilePath}
        recentFiles={recentFiles}
        onOpenFile={(rootPath, relPath) => void openEditorTab(rootPath, relPath)}
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
        teamHistory={teamHistoryEntries}
        onResumeTeam={(entry) => void handleResumeTeam(entry)}
        onDeleteTeamHistory={(id) => void handleDeleteTeamHistory(id)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      {/* Issue #337: サイドバー幅調整ハンドル */}
      <div
        className="resize-handle resize-handle--sidebar"
        onMouseDown={onSidebarResizeStart}
        onDoubleClick={onSidebarResizeDouble}
        title="ドラッグでサイドバー幅を調整 / ダブルクリックでリセット"
        role="separator"
        aria-orientation="vertical"
      />
      <main className="main">
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
          {activeEditorTab ? (
            <div className="pane">
              <EditorView
                path={activeEditorTab.relPath}
                /* Issue #325: 画像ファイルを開いたとき ImagePreview で convertFileSrc を呼べるように
                   projectRoot (= ワークスペース絶対パス) を渡す。 */
                projectRoot={activeEditorTab.rootPath}
                content={activeEditorTab.content}
                dirty={activeEditorTab.content !== activeEditorTab.originalContent}
                isBinary={activeEditorTab.isBinary}
                loading={activeEditorTab.loading}
                error={activeEditorTab.error}
                /* Issue #35: 非 UTF-8 テキストは lossy 変換で読み込んでいるので編集不可にする */
                readOnly={activeEditorTab.lossyEncoding}
                readOnlyReason={
                  activeEditorTab.lossyEncoding ? t('editor.nonUtf8ReadOnly') : undefined
                }
                onChange={(v) => updateEditorContent(activeEditorTab.id, v)}
                onSave={() => void saveEditorTab(activeEditorTab.id)}
              />
            </div>
          ) : activeDiffTab ? (
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

      {/* diff / editor 表示中のみリサイズハンドルと右パネルを分離表示 */}
      {hasActiveContent && (
        <div
          className="resize-handle"
          onMouseDown={onClaudePanelResizeStart}
          title="ドラッグで IDE モードパネルの幅を調整"
          role="separator"
          aria-orientation="vertical"
        />
      )}
      <aside className={`claude-code-panel${hasActiveContent ? '' : ' claude-code-panel--full'}`}>
        <header className="claude-code-panel__header">
          <div className="claude-code-panel__title-wrap">
            <span
              className={`claude-code-panel__dot${
                terminalTabs.length > 0 && terminalTabs.every((tab) => tab.exited)
                  ? ' is-exited'
                  : ''
              }`}
            />
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
                    style={{ position: 'fixed', inset: 0, zIndex: 499 /* = tokens.css --z-cmd-backdrop */ }}
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
              <button
                className="toolbar__btn"
                onClick={() => {
                  handleCloseLeaderOnly(
                    pendingTeamClose.tabId,
                    pendingTeamClose.teamId
                  );
                  setPendingTeamClose(null);
                }}
              >
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
          data-panes-many={terminalTabs.length > 16 ? 'true' : undefined}
        >
          {shouldShowGlobalClaudeCheck(terminalTabs.length, claudeCheck.state) &&
            claudeCheck.state === 'checking' && (
            <div className="claude-not-found__body" style={{ padding: 40, textAlign: 'center' }}>
              {t('claudePanel.checking')}
            </div>
          )}
          {shouldShowGlobalClaudeCheck(terminalTabs.length, claudeCheck.state) &&
            claudeCheck.state === 'missing' && (
            <ClaudeNotFound
              error={claudeCheck.error}
              onRetry={() => void runClaudeCheck()}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          )}
          {projectRoot &&
            terminalTabs.map((tab) => (
              <div
                key={`pane-${tab.id}`}
                className={`terminal-pane${tab.id === activeTerminalTabId ? ' is-active' : ''}${dragOverTabId === tab.id && dragTabId !== tab.id ? ' drag-over' : ''}`}
                onClick={() => setActiveTerminalTabId(tab.id)}
              >
                {/* ペインヘッダー（エージェント + ロール + 閉じる）。
                    1 タブ + スタンドアロンではヘッダーを隠すが、カスタムタイトルが
                    設定されている場合は隠すと編集手段 (double-click) を失うので常に表示する。
                    Issue #91 */}
                {(terminalTabs.length > 1 || tab.teamId || tab.customLabel) && (
                  <div className="terminal-pane__header" {...getDnDProps(tab.id)}>
                    <span className={`terminal-tab__agent terminal-tab__agent--${tab.agent}`}>
                      {tab.agent === 'claude' ? 'C' : 'X'}
                    </span>
                    {tab.role === 'leader' && (
                      <Crown size={10} strokeWidth={2.5} className="terminal-tab__leader-icon" />
                    )}
                    {tab.role && (
                      <span className={`terminal-tab__role terminal-tab__role--${tab.role}`}>
                        {getRoleDisplayLabel(tab, terminalTabs)}
                      </span>
                    )}
                    {tab.teamId && (
                      <span className="terminal-pane__team-name">
                        {teams.find((t) => t.id === tab.teamId)?.name}
                      </span>
                    )}
                    {editingLabelTabId === tab.id ? (
                      <input
                        className="terminal-pane__label-input"
                        defaultValue={tab.customLabel ?? tab.label}
                        autoFocus
                        placeholder={tab.label}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={(e) => {
                          const trimmed = e.currentTarget.value.trim();
                          // 空入力 → customLabel を null に戻し、自動生成 label を再表示
                          setTerminalTabs((prev) =>
                            prev.map((t) =>
                              t.id === tab.id
                                ? { ...t, customLabel: trimmed === '' ? null : trimmed }
                                : t
                            )
                          );
                          // チーム所属なら team-history.json にも保存して resume 時に復元できるようにする
                          persistTerminalCustomLabel(tab, trimmed);
                          setEditingLabelTabId(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') e.currentTarget.blur();
                          if (e.key === 'Escape') setEditingLabelTabId(null);
                        }}
                      />
                    ) : (
                      <span
                        className="terminal-pane__label"
                        onDoubleClick={(e) => { e.stopPropagation(); setEditingLabelTabId(tab.id); }}
                        title={tab.customLabel ?? tab.label}
                      >
                        {tab.customLabel ?? tab.label}
                      </span>
                    )}
                    {tab.exited && (
                      <span className="terminal-pane__exit-badge" title={t('terminal.exitedTitle')}>
                        {t('terminal.exited')}
                      </span>
                    )}
                    <span style={{ flex: 1 }} />
                    {tab.exited && (
                      <button
                        className="terminal-pane__restart"
                        onClick={(e) => { e.stopPropagation(); restartTerminalTab(tab.id); }}
                        title={t('terminal.restart')}
                      >
                        <RotateCw size={12} strokeWidth={2} />
                      </button>
                    )}
                    <button
                      className="terminal-pane__close"
                      onClick={(e) => { e.stopPropagation(); closeTerminalTab(tab.id); }}
                    >
                      &times;
                    </button>
                  </div>
                )}
                {canRenderTerminalForAgent(tab.agent, claudeCheck.state) ? (
                  <TerminalView
                    key={`term-${tab.id}-v${tab.version}`}
                    // Issue #271: HMR remount 時に同じ PTY へ再 bind するための論理キー。
                    // tab.id + version で識別。restart は version を上げて key を変えるので
                    // 同時に sessionKey も変わり、HMR cache は cache miss → 新規 spawn に
                    // なる。HMR remount は version 不変のままなので、cache hit して既存
                    // PTY に attach する。
                    sessionKey={`term:${tab.id}:v${tab.version}`}
                    ref={(el) => {
                      if (el) terminalRefs.current.set(tab.id, el);
                      else terminalRefs.current.delete(tab.id);
                    }}
                    cwd={tab.cwd || settings.claudeCwd || projectRoot}
                    fallbackCwd={projectRoot}
                    command={
                      tab.agent === 'codex'
                        ? settings.codexCommand || 'codex'
                        : settings.claudeCommand || 'claude'
                    }
                    args={getTerminalArgs(tab)}
                    env={getTerminalEnv(tab)}
                    codexInstructions={getCodexInstructions(tab)}
                    teamId={tab.teamId ?? undefined}
                    visible={true}
                    initialMessage={getRolePrompt(tab)}
                    agentId={tab.agentId}
                    role={tab.role ?? undefined}
                    onStatus={(s) =>
                      setTerminalTabs((prev) =>
                        prev.map((t) => (t.id === tab.id ? { ...t, status: s } : t))
                      )
                    }
                    onActivity={() => markTerminalActivity(tab.id)}
                    onExit={() =>
                      setTerminalTabs((prev) =>
                        prev.map((t) => (t.id === tab.id ? { ...t, exited: true } : t))
                      )
                    }
                    onSessionId={(sid) => {
                      handleTerminalSessionId(tab, sid);
                      // Issue #660: 初回 spawn の `--session-id` 注入 → jsonl 永続化が
                      // 確認できたので freshSessionId を倒す。次回以降は --resume 経路。
                      markSessionPersisted(tab.id);
                    }}
                    onResize={(cols, rows) => reportTerminalSize(tab.id, cols, rows)}
                    initialCols={tab.initialCols ?? undefined}
                    initialRows={tab.initialRows ?? undefined}
                  />
                ) : claudeCheck.state === 'checking' ? (
                  <div className="claude-not-found__body" style={{ padding: 40, textAlign: 'center' }}>
                    {t('claudePanel.checking')}
                  </div>
                ) : (
                  <ClaudeNotFound
                    error={claudeCheck.error}
                    onRetry={() => void runClaudeCheck()}
                    onOpenSettings={() => setSettingsOpen(true)}
                  />
                )}
                {tab.exited && (
                  <div className="terminal-pane__exit-banner" onClick={(e) => e.stopPropagation()}>
                    <span className="terminal-pane__exit-banner-text">
                      {t('terminal.exitedBanner', { status: tab.status || t('terminal.exited') })}
                    </span>
                    <button
                      className="terminal-pane__exit-banner-btn"
                      onClick={() => restartTerminalTab(tab.id)}
                    >
                      <RotateCw size={12} strokeWidth={2.25} />
                      {t('terminal.restart')}
                    </button>
                    <button
                      className="terminal-pane__exit-banner-btn terminal-pane__exit-banner-btn--ghost"
                      onClick={() => closeTerminalTab(tab.id)}
                    >
                      {t('terminal.closeTab')}
                    </button>
                  </div>
                )}
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
        onReplayOnboarding={() => {
          void updateSettings({ hasCompletedOnboarding: false });
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

      <StatusBar
        gitStatus={gitStatus}
        activeFilePath={activeFilePath}
        terminalCount={terminalTabs.length}
      />

      {!settingsLoading && !settings.hasCompletedOnboarding && (
        <OnboardingWizard
          onComplete={async (patch) => {
            await updateSettings({ ...patch, hasCompletedOnboarding: true });
          }}
        />
      )}
    </div>
  );
}

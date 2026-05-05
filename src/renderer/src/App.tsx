import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  Clock,
  Command as CommandIcon,
  Crown,
  ExternalLink,
  File as FileIcon,
  Folder as FolderIcon,
  FolderPlus,
  LayoutGrid,
  Plus,
  PanelLeft,
  RefreshCw,
  RotateCw,
  Settings as SettingsIcon
} from 'lucide-react';
import type {
  GitFileChange,
  GitStatus,
  SessionInfo,
  TerminalAgent
} from '../../types/shared';
import { Sidebar, type SidebarView } from './components/Sidebar';
import { TabBar, type TabItem } from './components/TabBar';
import { Topbar } from './components/shell/Topbar';
import { Rail } from './components/shell/Rail';
import { StatusBar } from './components/shell/StatusBar';
import { ActivityPanel } from './components/shell/ActivityPanel';
import { useActivityFeed } from './lib/use-activity-feed';
import { TweaksPanel } from './components/overlays/TweaksPanel';
import { DiffView } from './components/DiffView';
import { EditorView } from './components/EditorView';
import { TerminalView, type TerminalViewHandle } from './components/TerminalView';
import { SettingsModal } from './components/SettingsModal';
import { CommandPalette } from './components/CommandPalette';
import { WelcomePane } from './components/WelcomePane';
import { OnboardingWizard } from './components/OnboardingWizard';
import { ContextMenu, type ContextMenuItem } from './components/ContextMenu';
import { MenuBar, MenuItem, MenuDivider, MenuSection } from './components/shell/MenuBar';
import { useRecruitListener } from './lib/use-recruit-listener';
import { useWindowFrameInsets } from './lib/use-window-frame-insets';
import { useHistoryBadgeCount } from './lib/use-history-badge-count';
import { ClaudeNotFound } from './components/ClaudeNotFound';
import { getStatusMascotState } from './lib/status-mascot';
import { useT } from './lib/i18n';
import {
  useSettingsActions,
  useSettingsLoading,
  useSettingsValue
} from './lib/settings-context';
import { useToast } from './lib/toast-context';
import { useUiStore } from './stores/ui';
import { dedupPrepend, listContainsPath } from './lib/path-norm';
import { useProjectLoader } from './lib/hooks/use-project-loader';
import { useFileTabs } from './lib/hooks/use-file-tabs';
import type { DiffTab, EditorTab } from './lib/hooks/use-file-tabs';
import {
  MAX_TERMINALS,
  TERMINAL_WARN_THRESHOLD,
  getRoleDisplayLabel,
  useTerminalTabs
} from './lib/hooks/use-terminal-tabs';
import type { TerminalTab } from './lib/hooks/use-terminal-tabs';
import { useTeamManagement } from './lib/hooks/use-team-management';
import { useLayoutResize } from './lib/hooks/use-layout-resize';
import { useAppShortcuts } from './lib/hooks/use-app-shortcuts';
import { useClaudeCheck } from './lib/hooks/use-claude-check';
import type { Command } from './lib/commands';
import { buildAppCommands } from './lib/app-commands';

// DiffTab / EditorTab の型定義は use-file-tabs.ts に移管済み (Issue #373 Phase 1-2)。

// MAX_TERMINALS / TERMINAL_WARN_THRESHOLD / TerminalTab 型 / getRoleDisplayLabel は
// use-terminal-tabs.ts に移管済み (Issue #373 Phase 1-3)。
// ROLE_DESC / ROLE_ORDER / generateTeamSystemPrompt / generateTeamAction は
// src/renderer/src/lib/team-prompts.ts に移管済み (Issue #373 Phase 1-4)。

export function App(): JSX.Element {
  // Issue #307: Windows 11 フレームレス最大化時の不可視リサイズ境界を CSS 変数で補正
  useWindowFrameInsets();
  const settingsLoading = useSettingsLoading();
  const { update: updateSettings, reset: resetSettings } = useSettingsActions();
  const settings = {
    claudeCommand: useSettingsValue('claudeCommand'),
    claudeArgs: useSettingsValue('claudeArgs'),
    claudeCwd: useSettingsValue('claudeCwd'),
    lastOpenedRoot: useSettingsValue('lastOpenedRoot'),
    recentProjects: useSettingsValue('recentProjects'),
    workspaceFolders: useSettingsValue('workspaceFolders'),
    claudeCodePanelWidth: useSettingsValue('claudeCodePanelWidth'),
    sidebarWidth: useSettingsValue('sidebarWidth'),
    codexCommand: useSettingsValue('codexCommand'),
    codexArgs: useSettingsValue('codexArgs'),
    language: useSettingsValue('language'),
    theme: useSettingsValue('theme'),
    density: useSettingsValue('density'),
    statusMascotVariant: useSettingsValue('statusMascotVariant'),
    hasCompletedOnboarding: useSettingsValue('hasCompletedOnboarding'),
    mcpAutoSetup: useSettingsValue('mcpAutoSetup')
  };
  const { showToast, dismissToast } = useToast();
  const t = useT();
  // Canvas モードでは App が裏で常時マウントされるが、下の初回タブ生成
  // useEffect を抑制して "迷子ターミナル" が裏で起動しないようにする。
  const viewMode = useUiStore((s) => s.viewMode);
  // Phase 1-8 (Issue #373): UI 系 state を useUiStore に集約。
  // settingsOpen は元々 zustand に存在 (Rail からも開ける用)、
  // paletteOpen / status は Phase 1-8 で追加。
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const paletteOpen = useUiStore((s) => s.paletteOpen);
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);
  const status = useUiStore((s) => s.status);

  // sidebar
  const [sidebarView, setSidebarView] = useState<SidebarView>('changes');

  // Phase 1-1 (Issue #373): プロジェクトローダ責務を hook に外出し。
  // confirmDiscardEditorTabs / onProjectSwitched / onLoaded はこのコンポーネント
  // の下方で宣言される state setter / 派生値に依存するため、ref 経由で渡す。
  // Phase 1-2/1-3/1-4 で各 hook に分散したらこの ref ブリッジは順次解消する。
  const confirmDiscardRef = useRef<() => boolean>(() => true);
  const projectSwitchedRef = useRef<(root: string) => void>(() => {});
  const projectLoadedRef = useRef<
    (snapshot: { gitStatus: GitStatus; sessions: SessionInfo[] }) => void
  >(() => {});
  const stableConfirmDiscard = useCallback(() => confirmDiscardRef.current(), []);
  const stableProjectSwitched = useCallback(
    (root: string) => projectSwitchedRef.current(root),
    []
  );
  const stableProjectLoaded = useCallback(
    (snapshot: { gitStatus: GitStatus; sessions: SessionInfo[] }) =>
      projectLoadedRef.current(snapshot),
    []
  );
  const {
    projectRoot,
    loadProject,
    refreshGit,
    gitStatus,
    gitLoading
  } = useProjectLoader({
    confirmDiscardEditorTabs: stableConfirmDiscard,
    onProjectSwitched: stableProjectSwitched,
    onLoaded: stableProjectLoaded
  });

  // Phase 1-2 (Issue #373): editor / diff tab + recentlyClosed を hook に外出し。
  // editor/diff の DnD は現状存在しない (DnD は terminal タブ専用) ため hook では扱わない。
  const {
    editorTabs,
    setEditorTabs,
    diffTabs,
    setDiffTabs,
    recentlyClosed,
    activeTabId,
    setActiveTabId,
    dirtyEditorTabs,
    confirmDiscardEditorTabs,
    openEditorTab,
    updateEditorContent,
    saveEditorTab,
    openDiffTab,
    refreshDiffTabsForPath,
    closeTab,
    togglePin,
    reopenLastClosed,
    cycleTab,
    resetForProjectSwitch: resetTabsForProjectSwitch
  } = useFileTabs({ projectRoot, refreshGit, gitStatus, showToast });

  // sessions
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState<boolean>(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  // teams / teamHistoryEntries / spawnStaggerTimers / teamHistory debounce / アンマウント
  // flush effect は use-team-management.ts に移管済み (Issue #373 Phase 1-4)。

  // tabs (editor / diff / recentlyClosed) は useFileTabs で集中管理する。
  const [sideBySide, setSideBySide] = useState<boolean>(true);

  // Phase 1-4 (Issue #373): teams / team-history / TeamHub 接続情報・doCloseTeam・
  // handleResumeTeam・get*Args 系は use-team-management.ts に集約。
  // useTerminalTabs ↔ useTeamManagement の唯一の逆方向参照 (closeTeam) を
  // ref ブリッジで解消する。
  const closeTeamRef = useRef<(teamId: string) => void>(() => {});
  const stableCloseTeam = useCallback(
    (teamId: string) => closeTeamRef.current(teamId),
    []
  );

  // <TerminalView> ref は hook 化対象外: TerminalView の JSX 配線が App.tsx 側に
  // 残るため。
  const terminalRefs = useRef(new Map<number, TerminalViewHandle>());

  // Phase 1-7 (Issue #373): Claude CLI 検査と起動時アップデーター遅延 effect を
  // hook に集約。
  const { claudeCheck, runClaudeCheck } = useClaudeCheck();

  // コンテキストメニュー
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    items: ContextMenuItem[];
  } | null>(null);

  // Phase 1-3 (Issue #373): terminal tabs の state / handler を hook に集約。
  const {
    terminalTabs,
    setTerminalTabs,
    activeTerminalTabId,
    setActiveTerminalTabId,
    activeTerminalIds,
    markTerminalActivity,
    addTerminalTab,
    closeTerminalTab,
    doCloseTab,
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
    nextTerminalIdRef,
    resetForProjectSwitch: resetTerminalsForProjectSwitch
  } = useTerminalTabs({
    viewMode,
    claudeReady: claudeCheck.state === 'ok',
    projectRoot,
    showToast,
    closeTeam: stableCloseTeam
  });

  // Phase 1-4 (Issue #373): teams / team-history / launch helpers を hook に集約。
  const {
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
    resetForProjectSwitch: resetTeamsForProjectSwitch
  } = useTeamManagement({
    projectRoot,
    showToast,
    terminalTabs,
    setTerminalTabs,
    setActiveTerminalTabId,
    nextTerminalIdRef,
    addTerminalTab,
    doCloseTab
  });
  closeTeamRef.current = doCloseTeam;

  // Claude CLI 検査 / 起動時アップデーター遅延 effect は use-claude-check.ts に
  // 移管済み (Issue #373 Phase 1-7)。

  // Issue #66: project_root の外部変更 (git pull / Claude 編集 / 他エディタ) を検知して
  //           UI を更新する。Rust 側 fs_watch が debounce した `project:files-changed` を emit。
  //           refreshGit と diffTabs は ref 経由で読むことで effect deps を [] に保てる。
  const fsWatchHandlersRef = useRef<{
    refreshGit: () => Promise<void>;
    refreshDiffTabsForPath: (p: string) => Promise<void>;
    diffTabs: { relPath: string }[];
  } | null>(null);
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      const u = await listen<string>('project:files-changed', () => {
        const h = fsWatchHandlersRef.current;
        if (!h) return;
        void h.refreshGit();
        for (const tab of h.diffTabs) {
          void h.refreshDiffTabsForPath(tab.relPath);
        }
      });
      if (cancelled) {
        u();
      } else {
        unlisten = u;
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Phase 1-5 (Issue #373): Claude Code パネル / サイドバーの drag リサイズと
  // CSS 変数同期は use-layout-resize.ts に集約。
  const {
    onClaudePanelResizeStart,
    onSidebarResizeStart,
    onSidebarResizeDouble
  } = useLayoutResize();

  // Phase 1-1 / 1-2 / 1-3 (Issue #373): loadProject / 初回ロード effect / タイトルバー
  // effect / refreshGit は use-project-loader.ts、editor/diff tab 関連は use-file-tabs.ts、
  // terminal tab 関連は use-terminal-tabs.ts、teams / team-history は
  // use-team-management.ts に移管済み。confirmDiscardEditorTabs / onProjectSwitched /
  // onLoaded を hook に橋渡しする。
  confirmDiscardRef.current = confirmDiscardEditorTabs;
  projectSwitchedRef.current = (root: string): void => {
    // editor/diff/terminal/teams のリセットはそれぞれの hook に委譲。
    resetTabsForProjectSwitch();
    setActiveSessionId(null);
    resetTeamsForProjectSwitch();
    resetTerminalsForProjectSwitch();
    void root; // root は現状未使用 (将来の拡張余地として残す)
  };
  projectLoadedRef.current = ({ sessions: sess }) => {
    setSessions(sess);
  };

  const handleRestart = useCallback(async () => {
    if (dirtyEditorTabs.length > 0) {
      // Issue #68: WebView の window.confirm ではなく Tauri ネイティブ dialog を使う。
      // @tauri-apps/plugin-dialog の ask を動的 import して重さを抑える。
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

  // refreshTeamHistory + projectRoot 変更時の自動ロードは use-team-management.ts
  // に移管済み (Issue #373 Phase 1-4)。

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

  // Issue #66: fs watcher の callback が ref 経由で最新 refresh 関数を引けるように同期。
  // openDiffTab / refreshDiffTabsForPath は use-file-tabs.ts に移管済み (Issue #373 Phase 1-2)。
  fsWatchHandlersRef.current = {
    refreshGit,
    refreshDiffTabsForPath,
    diffTabs
  };

  // ---------- エディタタブ ----------

  // openEditorTab / updateEditorContent / saveEditorTab は use-file-tabs.ts に移管済み
  // (Issue #373 Phase 1-2)。

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

  // ---------- プロジェクトメニュー操作 ----------

  const handleNewProject = useCallback(async () => {
    const folder = await window.api.dialog.openFolder('新規プロジェクト: 空フォルダを選択/作成');
    if (!folder) return;
    const empty = await window.api.dialog.isFolderEmpty(folder);
    const loaded = await loadProject(folder);
    if (!loaded) return;
    if (!empty) {
      showToast('フォルダが空ではありません。既存として開きます', { tone: 'warning' });
    } else {
      showToast('新規プロジェクトを作成', { tone: 'success' });
    }
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
    const loaded = await loadProject(parent);
    if (loaded) {
      showToast(`${file} の親フォルダをプロジェクトとして読み込みました`, { tone: 'info' });
    }
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

  // ---------- Issue #4: ワークスペースフォルダ管理 ----------

  const workspaceFolders = useMemo(
    () => (settings.workspaceFolders ?? []).filter((p) => p && p !== projectRoot),
    [settings.workspaceFolders, projectRoot]
  );

  const handleAddWorkspaceFolder = useCallback(async () => {
    const folder = await window.api.dialog.openFolder(t('appMenu.addWorkspaceDialogTitle'));
    if (!folder) return;
    const name = folder.split(/[\\/]/).pop() ?? folder;
    // Issue #67: 比較を normalize 後キーで行い、表記揺れ (大小文字 / `\` vs `/`) を吸収。
    if (listContainsPath([projectRoot], folder)) {
      showToast(t('workspace.alreadyAdded', { name }), { tone: 'info' });
      return;
    }
    const current = settings.workspaceFolders ?? [];
    if (listContainsPath(current, folder)) {
      showToast(t('workspace.alreadyAdded', { name }), { tone: 'info' });
      return;
    }
    await updateSettings({ workspaceFolders: [...current, folder] });
    showToast(t('workspace.added', { name }), { tone: 'success' });
  }, [settings.workspaceFolders, projectRoot, updateSettings, showToast, t]);

  const handleRemoveWorkspaceFolder = useCallback(
    (path: string) => {
      const current = settings.workspaceFolders ?? [];
      if (!current.includes(path)) return;
      const name = path.split(/[\\/]/).pop() ?? path;

      // Issue #33: 未保存タブの破棄確認を settings 更新より先に行う。
      // Cancel された場合は settings / tabs どちらも変更せず、UI と永続状態の整合を保つ。
      const closingTabs = editorTabs.filter((tab) => tab.rootPath === path);
      const dirty = closingTabs.filter(
        (t) => !t.isBinary && t.content !== t.originalContent
      );
      if (dirty.length > 0 && !confirmDiscardEditorTabs(closingTabs.map((t) => t.id))) {
        // 破棄キャンセル → 何も変更しない
        return;
      }
      if (closingTabs.length > 0) {
        setEditorTabs((prev) => prev.filter((t) => t.rootPath !== path));
      }
      void updateSettings({ workspaceFolders: current.filter((p) => p !== path) });
      showToast(t('workspace.removed', { name }), { tone: 'info' });
    },
    [
      settings.workspaceFolders,
      editorTabs,
      updateSettings,
      showToast,
      t,
      confirmDiscardEditorTabs
    ]
  );

  // Phase 1-9 (Issue #373): コマンドパレット用 Command[] 構築は lib/app-commands.ts に集約。
  // useMemo の deps 配列は呼び出し側に残し、react-hooks/exhaustive-deps が機能する形を維持。
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
  // Phase 1-8: paletteOpen / settingsOpen は useUiStore に集約済みなので opts 不要。
  useAppShortcuts({
    activeTabId,
    cycleTab,
    closeTab,
    reopenLastClosed,
    saveEditorTab
  });

  // 起動引数合成 (getTerminalArgs / getCodexInstructions / getTerminalEnv /
  // getRolePrompt) と チーム履歴 resume/削除 / Leader-only close /
  // 各種 team-history sync は use-team-management.ts に移管済み
  // (Issue #373 Phase 1-4)。
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
  const mascotState = useMemo(
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

  const projectName = projectRoot.split(/[\\/]/).pop() || 'no project';
  const activeTab = terminalTabs.find((t) => t.id === activeTerminalTabId) ?? null;

  const totalHistoryCount = sessions.length + teamHistoryEntries.length;
  const gitChangeCount = gitStatus?.ok ? gitStatus.files.length : 0;
  // gitStatus が読み込み済みかつ ok=false のときだけ Rail から Changes タブを外す。
  // 読み込み中 (null) は表示したまま (一瞬消えてチラつくのを避ける)。
  const hasGitRepo = gitStatus === null ? true : gitStatus.ok;
  // git リポジトリでないと判明した瞬間に sidebar が 'changes' なら 'files' へ自動退避
  useEffect(() => {
    if (!hasGitRepo && sidebarView === 'changes') {
      setSidebarView('files');
    }
  }, [hasGitRepo, sidebarView]);
  const activityFeed = useActivityFeed();
  // Phase 6: vibe-canvas:recruit/dismiss イベントを listen して canvas store に反映
  useRecruitListener();
  const activityOpen = useUiStore((s) => s.activityOpen);
  const setActivityOpen = useUiStore((s) => s.setActivityOpen);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const availableUpdate = useUiStore((s) => s.availableUpdate);

  // Issue #387: Rail の History バッジは「総件数」ではなく「未確認件数」。
  // 履歴パネル表示中 (sidebarView === 'sessions' かつ折り畳まれていない) を確認済みとみなす。
  const historyBadgeCount = useHistoryBadgeCount(
    totalHistoryCount,
    sidebarView === 'sessions' && !sidebarCollapsed
  );

  // 「更新」ボタンクリック: 確認ダイアログ → DL → install → (Win 以外) relaunch。
  // 実行中タブ数を runningTaskCount に渡し、ダイアログで警告できるようにする。
  const handleClickUpdate = useCallback(() => {
    void import('./lib/updater-check').then((m) =>
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
        onRestart={handleRestart}
        onOpenPalette={() => setPaletteOpen(true)}
        availableUpdate={availableUpdate}
        onClickUpdate={handleClickUpdate}
        menuBar={
          <MenuBar
            items={[
              {
                label: t('menubar.file'),
                children: (
                  <>
                    <MenuItem
                      icon={<FolderPlus size={14} strokeWidth={1.8} />}
                      label={t('appMenu.new')}
                      onClick={() => void handleNewProject()}
                    />
                    <MenuItem
                      icon={<FolderIcon size={14} strokeWidth={1.8} />}
                      label={t('appMenu.openFolder')}
                      onClick={() => void handleOpenFolder()}
                    />
                    <MenuItem
                      icon={<FileIcon size={14} strokeWidth={1.8} />}
                      label={t('appMenu.openFile')}
                      onClick={() => void handleOpenFile()}
                    />
                    <MenuItem
                      icon={<FolderPlus size={14} strokeWidth={1.8} />}
                      label={t('appMenu.addToWorkspace')}
                      onClick={() => void handleAddWorkspaceFolder()}
                    />
                    {(settings.recentProjects ?? []).length > 0 && (
                      <>
                        <MenuDivider />
                        <MenuSection label={t('appMenu.recent')} />
                        {(settings.recentProjects ?? []).slice(0, 6).map((p) => (
                          <MenuItem
                            key={p}
                            icon={<Clock size={13} strokeWidth={1.8} />}
                            label={p.split(/[\\/]/).filter(Boolean).pop() ?? p}
                            onClick={() => handleOpenRecent(p)}
                          />
                        ))}
                      </>
                    )}
                    <MenuDivider />
                    <MenuItem
                      icon={<RotateCw size={14} strokeWidth={1.8} />}
                      label={t('menubar.restart')}
                      onClick={() => void handleRestart()}
                    />
                  </>
                )
              },
              {
                label: t('menubar.view'),
                children: (
                  <>
                    <MenuItem
                      icon={<PanelLeft size={14} strokeWidth={1.8} />}
                      label={t('menubar.toggleSidebar')}
                      shortcut="Ctrl+B"
                      onClick={() => toggleSidebar()}
                    />
                    <MenuItem
                      icon={<LayoutGrid size={14} strokeWidth={1.8} />}
                      label={t('menubar.toggleCanvas')}
                      shortcut="Ctrl+Shift+M"
                      onClick={() => useUiStore.getState().toggleViewMode()}
                    />
                    <MenuDivider />
                    <MenuItem
                      icon={<CommandIcon size={14} strokeWidth={1.8} />}
                      label={t('menubar.openPalette')}
                      shortcut="Ctrl+Shift+P"
                      onClick={() => setPaletteOpen(true)}
                    />
                  </>
                )
              },
              {
                label: t('menubar.help'),
                children: (
                  <>
                    <MenuItem
                      icon={<RefreshCw size={14} strokeWidth={1.8} />}
                      label={t('updater.checkNow')}
                      onClick={() => {
                        void import('./lib/updater-check').then((m) =>
                          m.checkForUpdates({
                            language: settings.language,
                            showToast,
                            dismissToast,
                            manual: true,
                            runningTaskCount: terminalTabs.length
                          })
                        );
                      }}
                    />
                    <MenuItem
                      icon={<ExternalLink size={14} strokeWidth={1.8} />}
                      label={t('menubar.openGithub')}
                      onClick={() => {
                        void window.api.app.openExternal('https://github.com/yusei531642/vibe-editor');
                      }}
                    />
                    <MenuDivider />
                    <MenuItem
                      icon={<SettingsIcon size={14} strokeWidth={1.8} />}
                      label={t('menubar.openSettings')}
                      shortcut="Ctrl+,"
                      onClick={() => setSettingsOpen(true)}
                    />
                  </>
                )
              }
            ]}
          />
        }
      />
      <Rail
        sidebarView={sidebarView}
        onSidebarViewChange={setSidebarView}
        changeCount={gitChangeCount}
        historyBadgeCount={historyBadgeCount}
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
          title="ドラッグで Claude Code パネルの幅を調整"
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
                  cwd={settings.claudeCwd || projectRoot}
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
                  onSessionId={(sid) => handleTerminalSessionId(tab, sid)}
                />
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
        mascotState={mascotState}
      />

      {activityOpen ? (
        <ActivityPanel
          className="activity--drawer"
          events={activityFeed.events}
          onClose={() => setActivityOpen(false)}
        />
      ) : null}

      <TweaksPanel />

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

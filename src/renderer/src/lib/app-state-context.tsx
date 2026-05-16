/**
 * app-state-context — App.tsx の god component 化を解消するための統合状態 Provider
 * (Issue #731)。
 *
 * 旧 App.tsx は `useProjectLoader` / `useFileTabs` / `useTerminalTabs` /
 * `useTeamManagement` を逐次呼び出し、hook 同士の循環参照を 5 連発の `useRef`
 * ブリッジ (confirmDiscardRef / projectSwitchedRef / projectLoadedRef /
 * discardEditorTabsForRootRef / closeTeamRef) で先送りしていた。
 *
 * この Provider は **その hook 統合層と ref ブリッジをそっくり内部へ閉じ込める**。
 * App.tsx / AppShell からは ref ブリッジが完全に見えなくなり、代わりに
 * 3 つの分離した consumer hook で必要な slice だけ購読できる:
 *
 *   - `useProject()` — projectRoot / git status / プロジェクトメニュー handler
 *   - `useTabs()`    — editor / diff タブ + activeTabId + タブ操作 handler
 *   - `useTeam()`    — terminal タブ / teams / team-history / launch helpers /
 *                      Claude CLI 検査
 *
 * 設計上の不変条件 (振る舞いを 1 mm も変えない):
 *   - hook の呼び出し順序・opts・戻り値の配線は旧 App.tsx と完全一致。
 *   - ref ブリッジへの代入タイミング (render body 内) も旧コードと同じ位置を維持。
 *     `confirmDiscardRef.current = ...` は hook 呼び出し直後の render 中代入で、
 *     これにより loadProject (非同期) が走る時点では常に最新の関数を引ける。
 *   - StrictMode 二重 mount でも安全: ref 代入は冪等、effect は cleanup 付き。
 *
 * Provider は **1 つ** だが公開 Context は 3 つに分割している。これにより
 * 「子コンポーネントが必要な Context だけ購読する」依存性逆転 (issue の方針 4)
 * が成立する。Provider 内部で全 hook をまとめて呼ぶのは、hook 間の循環参照を
 * Provider を跨がせず 1 箇所に閉じるため (3 Provider に割ると ref ブリッジが
 * Provider 間に移るだけになる)。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode
} from 'react';
import { listen } from '@tauri-apps/api/event';
import type { GitStatus, SessionInfo } from '../../../types/shared';
import { useToast } from './toast-context';
import { useUiStore } from '../stores/ui';
import { useProjectLoader } from './hooks/use-project-loader';
import type { UseProjectLoaderResult } from './hooks/use-project-loader';
import { useFileTabs } from './hooks/use-file-tabs';
import type { UseFileTabsResult } from './hooks/use-file-tabs';
import { useTerminalTabs } from './hooks/use-terminal-tabs';
import type { UseTerminalTabsResult } from './hooks/use-terminal-tabs';
import { useTerminalTabsPersistence } from './hooks/use-terminal-tabs-persistence';
import { useTeamManagement } from './hooks/use-team-management';
import type { UseTeamManagementResult } from './hooks/use-team-management';
import { useClaudeCheck } from './hooks/use-claude-check';

// ---------------------------------------------------------------------------
// Context 値の型
// ---------------------------------------------------------------------------

/** プロジェクト管理 slice。openProject / closeProject / currentProject の状態と handler。 */
export type ProjectContextValue = UseProjectLoaderResult;

/** タブ管理 slice。editor / diff タブ + activeTabId + タブ操作 handler。 */
export type TabsContextValue = UseFileTabsResult;

/** チーム / ターミナル slice。terminal タブ + teams + team-history + launch helpers。 */
export interface TeamContextValue
  extends UseTerminalTabsResult,
    UseTeamManagementResult {
  /** Claude CLI 検査結果 (use-claude-check)。 */
  claudeCheck: ReturnType<typeof useClaudeCheck>['claudeCheck'];
  /** Claude CLI 再検査を手動トリガする。 */
  runClaudeCheck: ReturnType<typeof useClaudeCheck>['runClaudeCheck'];
  /** TerminalView の `onResize` から PTY size 変化を永続化 hook へ流す。 */
  reportTerminalSize: ReturnType<
    typeof useTerminalTabsPersistence
  >['reportSize'];
}

const ProjectContext = createContext<ProjectContextValue | null>(null);
const TabsContext = createContext<TabsContextValue | null>(null);
const TeamContext = createContext<TeamContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface AppStateProviderProps {
  children: ReactNode;
  /**
   * loadProject / 初回ロード effect が取得した sessions snapshot を上に流す
   * (events-up)。旧 App.tsx は `projectLoadedRef.current` で `setSessions(sess)`
   * を直接呼んでいたが、sessions UI state は AppShell 側に残るため callback で
   * 受け渡す。AppShell が自身の `setSessions` を安定参照で渡す。
   */
  onSessionsLoaded?: (sessions: SessionInfo[]) => void;
}

export function AppStateProvider({
  children,
  onSessionsLoaded
}: AppStateProviderProps): JSX.Element {
  const { showToast } = useToast();
  // onSessionsLoaded を ref に詰めて render body 内のブリッジ代入から最新参照を引く。
  const onSessionsLoadedRef = useRef(onSessionsLoaded);
  onSessionsLoadedRef.current = onSessionsLoaded;
  // Canvas モードでは App が裏で常時マウントされるため、useTerminalTabs に
  // viewMode を渡して「迷子ターミナル」の裏起動を抑制する (旧 App.tsx と同じ)。
  const viewMode = useUiStore((s) => s.viewMode);

  // ----- ref ブリッジ (Issue #731 でこの Provider 内部へ閉じ込めた) -----
  // confirmDiscardEditorTabs / onProjectSwitched / onLoaded /
  // discardEditorTabsForRoot は use-file-tabs / use-terminal-tabs /
  // use-team-management の戻り値に依存するため、それらが宣言される前に
  // useProjectLoader へ渡すには ref 経由のブリッジが必要。
  const confirmDiscardRef = useRef<() => boolean>(() => true);
  const projectSwitchedRef = useRef<(root: string) => void>(() => {});
  const projectLoadedRef = useRef<
    (snapshot: { gitStatus: GitStatus; sessions: SessionInfo[] }) => void
  >(() => {});
  // handleRemoveWorkspaceFolder の「rootPath で editor タブを整理する」ブリッジ。
  // useFileTabs の戻り値が確定するまでは true を返す noop。
  const discardEditorTabsForRootRef = useRef<(rootPath: string) => boolean>(
    () => true
  );
  const stableConfirmDiscard = useCallback(
    () => confirmDiscardRef.current(),
    []
  );
  const stableProjectSwitched = useCallback(
    (root: string) => projectSwitchedRef.current(root),
    []
  );
  const stableProjectLoaded = useCallback(
    (snapshot: { gitStatus: GitStatus; sessions: SessionInfo[] }) =>
      projectLoadedRef.current(snapshot),
    []
  );
  const stableDiscardForRoot = useCallback(
    (rootPath: string) => discardEditorTabsForRootRef.current(rootPath),
    []
  );

  // ----- プロジェクトローダ -----
  const project = useProjectLoader({
    confirmDiscardEditorTabs: stableConfirmDiscard,
    onProjectSwitched: stableProjectSwitched,
    onLoaded: stableProjectLoaded,
    showToast,
    discardEditorTabsForRoot: stableDiscardForRoot
  });
  const { projectRoot, refreshGit, gitStatus } = project;

  // ----- editor / diff タブ -----
  const tabs = useFileTabs({ projectRoot, refreshGit, gitStatus, showToast });
  const {
    editorTabs,
    setEditorTabs,
    diffTabs,
    refreshDiffTabsForPath,
    confirmDiscardEditorTabs,
    resetForProjectSwitch: resetTabsForProjectSwitch
  } = tabs;

  // ----- Claude CLI 検査 / 起動時アップデーター遅延 -----
  const { claudeCheck, runClaudeCheck } = useClaudeCheck();

  // ----- useTerminalTabs ↔ useTeamManagement の唯一の逆方向参照 (closeTeam) -----
  const closeTeamRef = useRef<(teamId: string) => void>(() => {});
  const stableCloseTeam = useCallback(
    (teamId: string) => closeTeamRef.current(teamId),
    []
  );

  // ----- terminal タブ -----
  const terminal = useTerminalTabs({
    viewMode,
    claudeReady: claudeCheck.state === 'ok',
    projectRoot,
    showToast,
    closeTeam: stableCloseTeam
  });
  const {
    terminalTabs,
    setTerminalTabs,
    activeTerminalTabId,
    setActiveTerminalTabId,
    addTerminalTab,
    doCloseTab,
    nextTerminalIdRef,
    resetForProjectSwitch: resetTerminalsForProjectSwitch
  } = terminal;

  // ----- IDE タブ永続化 (Issue #661 / #662) -----
  const { reportSize: reportTerminalSize } = useTerminalTabsPersistence({
    projectRoot,
    terminalTabs,
    activeTerminalTabId,
    setActiveTerminalTabId,
    addTerminalTab
  });

  // ----- teams / team-history / launch helpers -----
  const team = useTeamManagement({
    projectRoot,
    showToast,
    terminalTabs,
    setTerminalTabs,
    setActiveTerminalTabId,
    nextTerminalIdRef,
    addTerminalTab,
    doCloseTab
  });
  const { doCloseTeam, resetForProjectSwitch: resetTeamsForProjectSwitch } =
    team;
  closeTeamRef.current = doCloseTeam;

  // ----- ref ブリッジへの代入 (render body 内: 旧 App.tsx と同位置) -----
  // confirmDiscardEditorTabs / onProjectSwitched / onLoaded を hook に橋渡しする。
  // editor/diff/terminal/teams のリセットはそれぞれの hook に委譲。
  confirmDiscardRef.current = confirmDiscardEditorTabs;
  projectSwitchedRef.current = (root: string): void => {
    resetTabsForProjectSwitch();
    resetTeamsForProjectSwitch();
    resetTerminalsForProjectSwitch();
    void root; // root は現状未使用 (将来の拡張余地として残す)
  };
  // onLoaded で受け取った sessions snapshot を AppShell へ流す
  // (旧 App.tsx の `projectLoadedRef.current = ({ sessions }) => setSessions(sessions)`
  // と同等。setSessions は AppShell の sessions UI state に属するため callback 経由)。
  projectLoadedRef.current = ({ sessions: sess }) => {
    onSessionsLoadedRef.current?.(sess);
  };

  // handleRemoveWorkspaceFolder で「rootPath = path のエディタタブを破棄する」
  // ブリッジ関数を ref に差し込む (Issue #33 の約束を維持: dirty があれば確認、
  // Cancel なら settings / tabs どちらも変更しない)。
  discardEditorTabsForRootRef.current = (path: string): boolean => {
    const closingTabs = editorTabs.filter((tab) => tab.rootPath === path);
    const dirty = closingTabs.filter(
      (tab) => !tab.isBinary && tab.content !== tab.originalContent
    );
    if (
      dirty.length > 0 &&
      !confirmDiscardEditorTabs(closingTabs.map((tab) => tab.id))
    ) {
      return false;
    }
    if (closingTabs.length > 0) {
      setEditorTabs((prev) => prev.filter((tab) => tab.rootPath !== path));
    }
    return true;
  };

  // ----- fs watcher (Issue #66) -----
  // project_root の外部変更 (git pull / Claude 編集 / 他エディタ) を検知して
  // UI を更新する。refreshGit と diffTabs は ref 経由で読むことで effect deps を
  // [] に保つ (旧 App.tsx の fsWatchHandlersRef をそのまま移植)。
  const fsWatchHandlersRef = useRef<{
    refreshGit: () => Promise<void>;
    refreshDiffTabsForPath: (p: string) => Promise<void>;
    diffTabs: { relPath: string }[];
  } | null>(null);
  fsWatchHandlersRef.current = {
    refreshGit,
    refreshDiffTabsForPath,
    diffTabs
  };
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

  // ----- Context 値 (各 slice の参照が変わったときだけ再構築) -----
  const teamValue = useMemo<TeamContextValue>(
    () => ({
      ...terminal,
      ...team,
      claudeCheck,
      runClaudeCheck,
      reportTerminalSize
    }),
    [terminal, team, claudeCheck, runClaudeCheck, reportTerminalSize]
  );

  return (
    <ProjectContext.Provider value={project}>
      <TabsContext.Provider value={tabs}>
        <TeamContext.Provider value={teamValue}>{children}</TeamContext.Provider>
      </TabsContext.Provider>
    </ProjectContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// consumer hook
// ---------------------------------------------------------------------------

/** プロジェクト管理 slice を購読する。 */
export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) {
    throw new Error('useProject は AppStateProvider の子孫で呼び出してください');
  }
  return ctx;
}

/** タブ管理 slice を購読する。 */
export function useTabs(): TabsContextValue {
  const ctx = useContext(TabsContext);
  if (!ctx) {
    throw new Error('useTabs は AppStateProvider の子孫で呼び出してください');
  }
  return ctx;
}

/** チーム / ターミナル slice を購読する。 */
export function useTeam(): TeamContextValue {
  const ctx = useContext(TeamContext);
  if (!ctx) {
    throw new Error('useTeam は AppStateProvider の子孫で呼び出してください');
  }
  return ctx;
}

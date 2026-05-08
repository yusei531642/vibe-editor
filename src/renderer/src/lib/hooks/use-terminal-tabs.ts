import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  TerminalAgent,
  TeamRole
} from '../../../../types/shared';

/** 同時に立てられるターミナルの上限。メモリ/レイアウト保護の安全弁 */
export const MAX_TERMINALS = 30;
/** この数を超えたら警告トーストを出す */
export const TERMINAL_WARN_THRESHOLD = 25;

export interface TerminalTab {
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
  /** チーム履歴で使う member インデックス。未所属タブは null */
  teamHistoryMemberIdx: number | null;
  /** 自動生成されたデフォルトラベル（"Claude #1" / "Programmer A" など） */
  label: string;
  /** ユーザーが手動でリネームした値。空入力で blur すると null に戻り label が表示される */
  customLabel: string | null;
}

/** 重複ロールにレター接尾辞を付けた表示名を返す (例: "programmer A") */
export function getRoleDisplayLabel(tab: TerminalTab, allTabs: TerminalTab[]): string {
  if (!tab.role) return '';
  if (!tab.teamId) return tab.role;
  const sameRole = allTabs
    .filter((t) => t.teamId === tab.teamId && t.role === tab.role)
    .sort((a, b) => a.agentId.localeCompare(b.agentId));
  if (sameRole.length <= 1) return tab.role;
  const idx = sameRole.findIndex((t) => t.id === tab.id);
  return `${tab.role} ${String.fromCharCode(65 + idx)}`;
}

export interface AddTerminalTabOptions {
  agent?: TerminalAgent;
  role?: TeamRole | null;
  teamId?: string | null;
  resumeSessionId?: string | null;
  agentId?: string;
  teamHistoryMemberIdx?: number | null;
  /** team-history からの resume 時に復元する手動リネーム名 */
  customLabel?: string | null;
}

type ToastFn = (
  msg: string,
  opts?: { tone?: 'info' | 'success' | 'warning' | 'error' }
) => void;

export interface UseTerminalTabsOptions {
  /** Canvas 裏マウント時の初回タブ自動生成抑制に使う。 */
  viewMode: 'ide' | 'canvas';
  /** Claude CLI 検査が通ったか。初回タブ自動生成のガード。 */
  claudeReady: boolean;
  /** 初回タブ自動生成のガード (use-project-loader の戻り値)。 */
  projectRoot: string;
  /** 上限警告 / 復元失敗トースト用。 */
  showToast: ToastFn;
  /**
   * leader タブを閉じる確認後、または leader 1 人だけの "empty team" を
   * 即終了するパスで呼ばれる callback。Phase 1-4 (use-team-management) が
   * doCloseTeam を提供し、App.tsx 側で ref ブリッジ経由で注入する
   * (teams setter / clearSpawnTimers / cleanupTeamMcp が絡むため
   * 本 hook 内で完結させない)。
   */
  closeTeam: (teamId: string) => void;
}

export interface DnDHandlers {
  draggable: true;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}

export interface UseTerminalTabsResult {
  // ---- state ----
  terminalTabs: TerminalTab[];
  setTerminalTabs: React.Dispatch<React.SetStateAction<TerminalTab[]>>;
  activeTerminalTabId: number;
  setActiveTerminalTabId: React.Dispatch<React.SetStateAction<number>>;

  // ---- mascot 用の activity Set (Issue #363) ----
  activeTerminalIds: ReadonlySet<number>;
  markTerminalActivity: (tabId: number) => void;

  // ---- handlers ----
  addTerminalTab: (opts?: AddTerminalTabOptions) => number | null;
  closeTerminalTab: (tabId: number) => void;
  /** team-aware close path で leader を **タブ単独閉じ** にする時に使う薄い wrapper */
  doCloseTab: (tabId: number) => void;
  restartTerminalTab: (tabId: number) => void;
  restartTerminal: () => void;

  // ---- tab create menu UI ----
  tabCreateMenuOpen: boolean;
  setTabCreateMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;

  // ---- pending team close confirmation ----
  pendingTeamClose: { tabId: number; teamId: string } | null;
  setPendingTeamClose: React.Dispatch<
    React.SetStateAction<{ tabId: number; teamId: string } | null>
  >;

  // ---- DnD ----
  dragTabId: number | null;
  dragOverTabId: number | null;
  /** ペインヘッダー draggable に渡す bundle。JSX 側で展開して使う。 */
  getDnDProps: (tabId: number) => DnDHandlers;

  // ---- inline label edit ----
  editingLabelTabId: number | null;
  setEditingLabelTabId: React.Dispatch<React.SetStateAction<number | null>>;

  // ---- next id ref (App.tsx 残置 callback で id 採番が必要な場合に使う) ----
  nextTerminalIdRef: React.MutableRefObject<number>;

  // ---- project switch lifecycle ----
  /** projectSwitchedRef.current から呼ぶ。ターミナルは自動生成せず空の初期画面に戻す。 */
  resetForProjectSwitch: () => void;
}

/**
 * Issue #373 Phase 1-3: terminal tabs の state container と自己完結ハンドラを
 * App.tsx から切り出した hook。
 *
 * - opts は `optsRef.current = opts` で毎 render 更新し、内部 useCallback の
 *   deps から外す (use-project-loader.ts / use-file-tabs.ts と同じ流儀)。
 * - team / TeamHub / spawn / role 系は Phase 1-4 待ち。teams は read-only に
 *   opts 経由で受け取り、doCloseTeam は callback として外注する。
 * - terminalRefs (TerminalViewHandle Map) は <TerminalView> JSX が App.tsx に
 *   残るため hook では持たない。
 */
export function useTerminalTabs(opts: UseTerminalTabsOptions): UseTerminalTabsResult {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const [terminalTabs, setTerminalTabs] = useState<TerminalTab[]>([]);
  const [activeTerminalTabId, setActiveTerminalTabId] = useState<number>(0);
  const nextTerminalIdRef = useRef(1);

  // Issue #363: hasActivity を terminalTabs に持たせると PTY data 受信ごとに
  // setTerminalTabs が走り、TerminalView の親 App 全体が ~16ms 周期で再レンダーする。
  // mascot 表示のためだけに 60Hz で App を回すのは IDE モード xterm の初期化と
  // 衝突するので、activity フラグは別 Set state として TerminalView の props と
  // 完全に切り離す (Set 更新は mascot の StatusBar 経路のみに伝搬)。
  const terminalActivityTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const [activeTerminalIds, setActiveTerminalIds] = useState<ReadonlySet<number>>(
    () => new Set()
  );

  const [tabCreateMenuOpen, setTabCreateMenuOpen] = useState(false);
  const [pendingTeamClose, setPendingTeamClose] = useState<{
    tabId: number;
    teamId: string;
  } | null>(null);
  const [dragTabId, setDragTabId] = useState<number | null>(null);
  const [dragOverTabId, setDragOverTabId] = useState<number | null>(null);
  const [editingLabelTabId, setEditingLabelTabId] = useState<number | null>(null);

  const markTerminalActivity = useCallback((tabId: number) => {
    const existing = terminalActivityTimers.current.get(tabId);
    if (existing) window.clearTimeout(existing);

    setActiveTerminalIds((prev) => {
      if (prev.has(tabId)) return prev;
      const next = new Set(prev);
      next.add(tabId);
      return next;
    });

    const timer = window.setTimeout(() => {
      terminalActivityTimers.current.delete(tabId);
      setActiveTerminalIds((prev) => {
        if (!prev.has(tabId)) return prev;
        const next = new Set(prev);
        next.delete(tabId);
        return next;
      });
    }, 900);
    terminalActivityTimers.current.set(tabId, timer);
  }, []);

  useEffect(() => {
    const timers = terminalActivityTimers.current;
    return () => {
      for (const timer of timers.values()) {
        window.clearTimeout(timer);
      }
      timers.clear();
    };
  }, []);

  const addTerminalTab = useCallback(
    (addOpts?: AddTerminalTabOptions): number | null => {
      const id = nextTerminalIdRef.current++;
      const agentType = addOpts?.agent ?? 'claude';
      let accepted = false;
      setTerminalTabs((prev) => {
        // ラベル自動生成: チームロール or 連番
        let label: string;
        if (addOpts?.role) {
          const sameRole = prev.filter(
            (t) => t.teamId === addOpts.teamId && t.role === addOpts.role
          );
          const roleName = addOpts.role.charAt(0).toUpperCase() + addOpts.role.slice(1);
          label = sameRole.length > 0 ? `${roleName} ${String.fromCharCode(65 + sameRole.length)}` : roleName;
        } else {
          const agentLabel = agentType === 'claude' ? 'Claude' : 'Codex';
          const sameAgent = prev.filter((t) => t.agent === agentType && !t.role);
          label = `${agentLabel} #${sameAgent.length + 1}`;
        }
        const tab: TerminalTab = {
          id,
          version: 0,
          agent: agentType,
          role: addOpts?.role ?? null,
          teamId: addOpts?.teamId ?? null,
          agentId: addOpts?.agentId ?? `agent-${id}`,
          status: '',
          exited: false,
          resumeSessionId: addOpts?.resumeSessionId ?? null,
          teamHistoryMemberIdx: addOpts?.teamHistoryMemberIdx ?? null,
          label,
          customLabel: addOpts?.customLabel ?? null
        };
        if (prev.length >= MAX_TERMINALS) {
          optsRef.current.showToast(`ターミナル上限（${MAX_TERMINALS}）に達しました`, {
            tone: 'warning'
          });
          return prev;
        }
        // 閾値を超えそうなら軽く警告
        if (prev.length + 1 === TERMINAL_WARN_THRESHOLD) {
          optsRef.current.showToast(
            `ターミナル数が ${TERMINAL_WARN_THRESHOLD} に達しました（上限 ${MAX_TERMINALS}）`,
            { tone: 'info' }
          );
        }
        accepted = true;
        return [...prev, tab];
      });
      if (!accepted) return null;
      setActiveTerminalTabId(id);
      return id;
    },
    []
  );

  const doCloseTab = useCallback((tabId: number) => {
    setTerminalTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      if (next.length === 0) {
        setActiveTerminalTabId(0);
        return [];
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

  const closeTerminalTab = useCallback(
    (tabId: number) => {
      const tab = terminalTabs.find((t) => t.id === tabId);
      if (tab?.role === 'leader' && tab.teamId) {
        // Leader 1 人しか居ない "empty team" は確認ダイアログ不要。即チーム終了。
        const otherMembers = terminalTabs.filter(
          (t) => t.teamId === tab.teamId && t.id !== tabId
        );
        if (otherMembers.length === 0) {
          optsRef.current.closeTeam(tab.teamId);
          return;
        }
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
          ? { ...t, version: t.version + 1, exited: false, status: '' }
          : t
      )
    );
  }, []);

  const restartTerminal = useCallback(() => {
    restartTerminalTab(activeTerminalTabId);
  }, [activeTerminalTabId, restartTerminalTab]);

  // Issue #564: IDE 初期画面ではターミナルを自動生成しない。
  // ターミナル起動はユーザーの明示操作、team recruit、session resume だけに限定する。

  const getDnDProps = useCallback(
    (tabId: number): DnDHandlers => ({
      draggable: true,
      onDragStart: (e) => {
        setDragTabId(tabId);
        e.dataTransfer.effectAllowed = 'move';
      },
      onDragOver: (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setDragOverTabId(tabId);
      },
      onDragLeave: () => {
        setDragOverTabId((prev) => (prev === tabId ? null : prev));
      },
      onDrop: (e) => {
        e.preventDefault();
        setDragTabId((from) => {
          if (from !== null && from !== tabId) {
            setTerminalTabs((prev) => {
              const fromIdx = prev.findIndex((t) => t.id === from);
              const toIdx = prev.findIndex((t) => t.id === tabId);
              if (fromIdx === -1 || toIdx === -1) return prev;
              const next = [...prev];
              const [moved] = next.splice(fromIdx, 1);
              next.splice(toIdx, 0, moved);
              return next;
            });
          }
          return null;
        });
        setDragOverTabId(null);
      },
      onDragEnd: () => {
        setDragTabId(null);
        setDragOverTabId(null);
      }
    }),
    []
  );

  const resetForProjectSwitch = useCallback(() => {
    setTerminalTabs([]);
    setActiveTerminalTabId(0);
  }, []);

  return {
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
    resetForProjectSwitch
  };
}

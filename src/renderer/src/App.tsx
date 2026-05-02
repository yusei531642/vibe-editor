import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  GitDiffResult,
  GitFileChange,
  GitStatus,
  SessionInfo,
  Team,
  TeamHistoryEntry,
  TeamRole,
  TerminalAgent,
  ThemeName
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
import { webviewZoom } from './lib/webview-zoom';
import { parseShellArgs } from './lib/parse-args';
import { dedupPrepend, listContainsPath } from './lib/path-norm';
import { useProjectLoader } from './lib/hooks/use-project-loader';
import type { Command } from './lib/commands';

const THEMES_FOR_PALETTE: ThemeName[] = [
  'claude-dark',
  'claude-light',
  'dark',
  'midnight',
  'glass',
  'light'
];

interface DiffTab {
  id: string;
  relPath: string;
  result: GitDiffResult | null;
  loading: boolean;
  pinned: boolean;
}

interface EditorTab {
  id: string;
  /**
   * Issue #4: 開いているファイルがどのワークスペースルート配下かを記憶する。
   * 同名の相対パスが別ルートに存在し得るので、read/write や ID 衝突回避に必須。
   */
  rootPath: string;
  relPath: string;
  content: string;
  originalContent: string;
  isBinary: boolean;
  /**
   * Issue #35: 非 UTF-8 (CP932 など) を from_utf8_lossy で読んだ場合に true。
   * 編集は許可しない (保存すると lossy 変換後の UTF-8 で上書きされ、元 encoding を失うため)。
   */
  lossyEncoding: boolean;
  /**
   * Issue #102: read 時に検出した encoding。save 時にこの encoding で再エンコードして
   * 書き戻すことで UTF-16/UTF-32/UTF-8 BOM が UTF-8 にロスっと変換されるのを防ぐ。
   */
  encoding: string;
  /** Issue #65: 開いた時点の mtime (ms since epoch)。save 時の external-change 検出に使う */
  mtimeMs?: number;
  /** Issue #104: 開いた時点の size。mtime 解像度の粗い FS 用に併用検出する */
  sizeBytes?: number;
  /** Issue #119: 開いた時点の SHA-256 (hex)。同サイズ・1 秒以内の外部変更を検出するのに使う */
  contentHash?: string;
  loading: boolean;
  error: string | null;
  pinned: boolean;
}

/** 同時に立てられるターミナルの上限。メモリ/レイアウト保護の安全弁 */
const MAX_TERMINALS = 30;
/** この数を超えたら警告トーストを出す */
const TERMINAL_WARN_THRESHOLD = 25;

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
  /** チーム履歴で使う member インデックス。未所属タブは null */
  teamHistoryMemberIdx: number | null;
  /** 自動生成されたデフォルトラベル（"Claude #1" / "Programmer A" など） */
  label: string;
  /** ユーザーが手動でリネームした値。空入力で blur すると null に戻り label が表示される */
  customLabel: string | null;
}

/** ロール別の短い説明（チームプロンプト内で使用、leader 以外は動的ロール由来）。 */
const ROLE_DESC: Record<TeamRole, string> = {
  leader: '全体の調整・指示・タスク割り振り'
};

/**
 * ロスター表示用の固定順。leader を最優先に、それ以外は登場順。
 * vibe-team のロールは Leader が動的に作成するため、固定リスト化はしない。
 */
const ROLE_ORDER: Record<string, number> = {
  leader: 0
};

/** 重複ロールにレター接尾辞を付けた表示名を返す (例: "programmer A") */
function getRoleDisplayLabel(tab: TerminalTab, allTabs: TerminalTab[]): string {
  if (!tab.role) return '';
  if (!tab.teamId) return tab.role;
  const sameRole = allTabs
    .filter((t) => t.teamId === tab.teamId && t.role === tab.role)
    .sort((a, b) => a.agentId.localeCompare(b.agentId));
  if (sameRole.length <= 1) return tab.role;
  const idx = sameRole.findIndex((t) => t.id === tab.id);
  return `${tab.role} ${String.fromCharCode(65 + idx)}`;
}

/** チームのシステムプロンプト（--append-system-prompt 用） */
function generateTeamSystemPrompt(
  tab: TerminalTab,
  allTabs: TerminalTab[],
  team: Team | null
): string | undefined {
  if (!tab.role || !tab.teamId || !team) return undefined;

  const teamTabs = allTabs
    .filter((t) => t.teamId === tab.teamId)
    .slice()
    .sort((a, b) => {
      const ra = ROLE_ORDER[a.role ?? ''] ?? 99;
      const rb = ROLE_ORDER[b.role ?? ''] ?? 99;
      if (ra !== rb) return ra - rb;
      return a.agentId.localeCompare(b.agentId);
    });
  const roster = teamTabs
    .map((t) => {
      const agent = t.agent === 'claude' ? 'Claude Code' : 'Codex';
      const you = t.id === tab.id ? ' ← あなた' : '';
      const roleLabel = getRoleDisplayLabel(t, allTabs);
      return `${roleLabel || 'member'}(${agent})${you}`;
    })
    .join(', ');

  const mcpTools =
    'MCP vibe-team ツール: team_recruit(role_id,engine,label?,description?,instructions?) / team_dismiss / team_send(to,message) / team_read / team_info / team_status / team_assign_task(assignee,description) / team_get_tasks / team_update_task / team_list_role_profiles。' +
    'team_send/team_assign_task は相手のプロンプトにリアルタイム注入される。受信時は [Team ← <role>] プレフィックス付きで届く。';

  if (tab.role === 'leader') {
    return (
      `あなたはチーム「${team.name}」のLeader。構成: ${roster}。${mcpTools}\n` +
      `【絶対遵守ルール — 外部ファイルを読む前に先に従うこと】\n` +
      `1. ユーザーから最初の指示が来るまで何もせず待機する。自分からプロジェクト調査やファイル読みを開始しない。\n` +
      `2. ユーザー指示が届いたら、計画して委譲する。Read / Edit / Write / Bash / Grep / Glob などの作業系ツールを Leader 自身が呼んで実作業をしてはいけない。Leader の仕事は計画・委譲・レビュー。\n` +
      `【チーム編成とタスク委譲の使い分け】\n` +
      `(a) vibe-team (基本・可視化): team_recruit + team_assign_task を使うとキャンバス上にメンバーが視覚的に配置される。「チームを作って」「採用して」と言われたときや、通常のタスク委譲はこれを既定で使う。\n` +
      `(b) Claude Code Native Agent Teams (Task / dispatch_agent / general-purpose / Explore): ユーザーから「裏で Agent Teams を使って」「サブエージェントに任せて」と明示指示されたとき、またはキャンバスに表示するまでもない大量ファイル検索 / 裏側の単純並列タスクを Leader 自身の判断で行うときのみ使用。通常の委譲を勝手にこっちに振り替えない。\n` +
      `3. team_recruit は「ロール設計＋採用」を 1 コールで行う。新規ロール作成時の必須引数: role_id (snake_case), label, description, instructions, engine。` +
      `既存ロール (hr や自分が作成済みの role_id) の再採用は role_id + engine だけで OK。\n` +
      `4. 3 名以上必要なときは、まず team_recruit({role_id:"hr", engine:"claude"}) で HR を採用し、team_send("hr", "採用してほしい: ...") で一括採用を委譲する。\n` +
      `5. チームが揃ったら team_assign_task で割り振り、結果は [Team ← <role>] で届くので都度レビュー、追指示は team_send で行う。\n` +
      `6. 【長文ペイロード・ルール】team_recruit.instructions / team_send.message / team_assign_task.description は bracketed paste で配送されるので改行入り YAML / code / リストも ~32 KiB まではそのままインラインで OK。32 KiB を超える本文のみ Write で .vibe-team/tmp/<short_id>.md に書き出してから引数には「サマリ + パス」を渡す (Hub が 32 KiB 超を拒否)。\n` +
      `設計思想や応用パターンの詳細は .claude/skills/vibe-team/SKILL.md を Read ツールで参照可 (補助情報、必須ではない)。`
    );
  }

  // leader 以外: 役割の詳細はロールプロファイル (動的生成可能) 側で管理されるため、
  // ここでは固定の汎用文だけを返す。IDE 旧仕様の fallback。Canvas 側は AgentNodeCard が
  // renderSystemPrompt() で動的ロール instructions を含むプロンプトを組み立てる。
  const roleDesc = ROLE_DESC[tab.role] ?? `${tab.role}としての担当作業`;
  return (
    `あなたはチーム「${team.name}」の${tab.role}。役割:${roleDesc}。構成: ${roster}。${mcpTools}\n` +
    `【絶対ルール】\n` +
    `1. 指示が [Team ← leader] (または [Team ← <role>]) で届くまで何もしない。自発的な調査・コード変更は禁止。\n` +
    `2. 指示が届いたら作業を完遂し、直後に team_send('leader', "完了報告: ...") で簡潔に結果を返す。\n` +
    `3. 報告後は静かなアイドル状態に戻る。ポーリング・「承認待ち」表示・自発的な追加質問は禁止。次の指示は [Team ← ...] で自動的に届く。\n` +
    `4. 自分から他メンバーにタスクを割り振ってはいけない (それは Leader の仕事)。\n` +
    `5. 【長文ペイロード・ルール】team_send は bracketed paste で配送されるので改行入りの内容も ~32 KiB まではそのまま OK。それを超える場合のみ Write で .vibe-team/tmp/<short_id>.md に書き出してパスを渡す。`
  );
}

/** 短いアクション指示（initialMessage 用）。
 *  チーム所属タブは全員「待機」が基本方針なので何も送らない。
 *  Leader はユーザーからの最初の指示を待ち、メンバーは Leader からの注入を待つ。 */
function generateTeamAction(_tab: TerminalTab): string | undefined {
  return undefined;
}

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
    hasCompletedOnboarding: useSettingsValue('hasCompletedOnboarding'),
    mcpAutoSetup: useSettingsValue('mcpAutoSetup')
  };
  const { showToast, dismissToast } = useToast();
  const t = useT();
  // Canvas モードでは App が裏で常時マウントされるが、下の初回タブ生成
  // useEffect を抑制して "迷子ターミナル" が裏で起動しないようにする。
  const viewMode = useUiStore((s) => s.viewMode);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [paletteOpen, setPaletteOpen] = useState<boolean>(false);
  const [status, setStatus] = useState<string>('');

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
    onLoaded: stableProjectLoaded,
    setStatus
  });

  // sessions
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState<boolean>(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  // team history（プロジェクト単位で永続化）
  const [teamHistoryEntries, setTeamHistoryEntries] = useState<TeamHistoryEntry[]>([]);

  /** チーム作成時のメンバースポーン遅延タイマー。破棄時にクリアできるよう保持 */
  const spawnStaggerTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const clearSpawnTimers = useCallback(() => {
    for (const t of spawnStaggerTimers.current) clearTimeout(t);
    spawnStaggerTimers.current = [];
  }, []);
  /**
   * team history save のデバウンス。sessionId が順次取れてくるときに
   * N 回ファイルに書き出すのを避ける。entryId ごとに最新値を 500ms 後に flush。
   */
  const teamHistoryPending = useRef(new Map<string, TeamHistoryEntry>());
  const teamHistoryFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushTeamHistoryNow = useCallback((): void => {
    if (teamHistoryFlushTimer.current) {
      clearTimeout(teamHistoryFlushTimer.current);
      teamHistoryFlushTimer.current = null;
    }
    if (!window.api.teamHistory) {
      teamHistoryPending.current.clear();
      return;
    }
    const entries = Array.from(teamHistoryPending.current.values());
    teamHistoryPending.current.clear();
    for (const e of entries) {
      void window.api.teamHistory.save(e);
    }
  }, []);
  const saveTeamHistory = useCallback((entry: TeamHistoryEntry) => {
    if (!window.api.teamHistory) return;
    teamHistoryPending.current.set(entry.id, entry);
    if (teamHistoryFlushTimer.current) return;
    teamHistoryFlushTimer.current = setTimeout(() => {
      teamHistoryFlushTimer.current = null;
      const entries = Array.from(teamHistoryPending.current.values());
      teamHistoryPending.current.clear();
      for (const e of entries) {
        void window.api.teamHistory.save(e);
      }
    }, 500);
  }, []);
  // アンマウント(アプリ終了直前)で pending を即 flush
  useEffect(() => {
    return () => {
      flushTeamHistoryNow();
    };
  }, [flushTeamHistoryNow]);

  // tabs: diff タブと editor タブを並立させ、id プレフィックスで判別する
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [diffTabs, setDiffTabs] = useState<DiffTab[]>([]);
  const [editorTabs, setEditorTabs] = useState<EditorTab[]>([]);
  const [recentlyClosed, setRecentlyClosed] = useState<DiffTab[]>([]);
  const [sideBySide, setSideBySide] = useState<boolean>(true);

  // Claude Code / Codex terminal tabs (最大10個の同時実行をサポート)
  const [terminalTabs, setTerminalTabs] = useState<TerminalTab[]>([]);
  const [activeTerminalTabId, setActiveTerminalTabId] = useState<number>(0);
  const nextTerminalIdRef = useRef(1);
  const terminalRefs = useRef(new Map<number, TerminalViewHandle>());
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
  const [teams, setTeams] = useState<Team[]>([]);
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
    return () => {
      for (const timer of terminalActivityTimers.current.values()) {
        window.clearTimeout(timer);
      }
      terminalActivityTimers.current.clear();
    };
  }, []);

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
      teamHistoryMemberIdx?: number | null;
      /** team-history からの resume 時に復元する手動リネーム名 */
      customLabel?: string | null;
    }): number | null => {
      const id = nextTerminalIdRef.current++;
      const agentType = opts?.agent ?? 'claude';
      let accepted = false;
      setTerminalTabs((prev) => {
        // ラベル自動生成: チームロール or 連番
        let label: string;
        if (opts?.role) {
          const sameRole = prev.filter(
            (t) => t.teamId === opts.teamId && t.role === opts.role
          );
          const roleName = opts.role.charAt(0).toUpperCase() + opts.role.slice(1);
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
          role: opts?.role ?? null,
          teamId: opts?.teamId ?? null,
          agentId: opts?.agentId ?? `agent-${id}`,
          status: '',
          exited: false,
          resumeSessionId: opts?.resumeSessionId ?? null,
          teamHistoryMemberIdx: opts?.teamHistoryMemberIdx ?? null,
          label,
          customLabel: opts?.customLabel ?? null
        };
        if (prev.length >= MAX_TERMINALS) {
          showToast(`ターミナル上限（${MAX_TERMINALS}）に達しました`, { tone: 'warning' });
          return prev;
        }
        // 閾値を超えそうなら軽く警告
        if (prev.length + 1 === TERMINAL_WARN_THRESHOLD) {
          showToast(
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
    [showToast]
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
          teamHistoryMemberIdx: null,
          label: 'Claude #1',
          customLabel: null
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
      // チーム作成進行中ならスタガー spawn を止める（同じチームかは問わない）
      clearSpawnTimers();
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
            teamHistoryMemberIdx: null,
            label: 'Claude #1',
            customLabel: null
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
      // MCP クリーンアップ(失敗しても UI 側は続行。catch で unhandled rejection を抑止)
      if (projectRoot) {
        window.api.app
          .cleanupTeamMcp(projectRoot, teamId)
          .catch((err) => console.warn('[team] cleanupTeamMcp failed:', err));
      }
    },
    [projectRoot, clearSpawnTimers]
  );

  const closeTerminalTab = useCallback(
    (tabId: number) => {
      const tab = terminalTabs.find((t) => t.id === tabId);
      if (tab?.role === 'leader' && tab.teamId) {
        // Leader 1 人しか居ない "empty team" は確認ダイアログ不要。即チーム終了。
        const otherMembers = terminalTabs.filter(
          (t) => t.teamId === tab.teamId && t.id !== tabId
        );
        if (otherMembers.length === 0) {
          doCloseTeam(tab.teamId);
          return;
        }
        setPendingTeamClose({ tabId, teamId: tab.teamId });
        return;
      }
      doCloseTab(tabId);
    },
    [terminalTabs, doCloseTab, doCloseTeam]
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

  // 起動時に GitHub Release の latest.json を「確認だけ」する (prod のみ)。
  // 旧仕様の「ask → 即 install → relaunch」は撤廃。代わりに silentCheckForUpdate で
  // 更新の有無を検出して useUiStore.availableUpdate に書き、Topbar / CanvasLayout の
  // 「Update」ボタンを点灯させる。実 install はユーザーがボタンを押したときだけ走る。
  // 起動直後の負荷を避けるため少し遅延させる (5 秒)。
  useEffect(() => {
    let cancelled = false;
    const handle = window.setTimeout(() => {
      void import('./lib/updater-check').then(async (m) => {
        const info = await m.silentCheckForUpdate();
        if (cancelled) return;
        useUiStore.getState().setAvailableUpdate(info);
      });
    }, 5_000);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, []);

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
      const { listen } = await import('@tauri-apps/api/event');
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

  // ---------- Claude Code パネル リサイズ ----------
  const MIN_PANEL = 320;
  const MAX_PANEL = 900;
  const resizeDragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // ---------- サイドバー リサイズ (Issue #337) ----------
  const MIN_SIDEBAR = 200;
  const MAX_SIDEBAR = 600;
  const DEFAULT_SIDEBAR = 272;
  const sidebarResizeDragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // 設定からの初期幅を CSS 変数に反映
  useEffect(() => {
    const w = Math.max(
      MIN_PANEL,
      Math.min(MAX_PANEL, settings.claudeCodePanelWidth ?? 460)
    );
    document.documentElement.style.setProperty('--claude-code-width', `${w}px`);
  }, [settings.claudeCodePanelWidth]);

  // Issue #337: サイドバー幅を CSS 変数に反映
  useEffect(() => {
    const w = Math.max(
      MIN_SIDEBAR,
      Math.min(MAX_SIDEBAR, settings.sidebarWidth ?? DEFAULT_SIDEBAR)
    );
    document.documentElement.style.setProperty('--shell-sidebar-w', `${w}px`);
  }, [settings.sidebarWidth]);

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

  // Issue #337: サイドバーと main の境界をドラッグして幅を調整する
  const handleSidebarResizeStart = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      const currentWidth = Math.max(
        MIN_SIDEBAR,
        Math.min(MAX_SIDEBAR, settings.sidebarWidth ?? DEFAULT_SIDEBAR)
      );
      sidebarResizeDragRef.current = {
        startX: e.clientX,
        startWidth: currentWidth
      };
      document.body.classList.add('is-resizing');
      const handleEl = e.currentTarget;
      handleEl.classList.add('is-dragging');

      let latestWidth = currentWidth;

      const onMove = (ev: MouseEvent): void => {
        const drag = sidebarResizeDragRef.current;
        if (!drag) return;
        // 右へドラッグ = width 増える (claude-code-panel と方向が逆)
        const dx = ev.clientX - drag.startX;
        const next = Math.max(
          MIN_SIDEBAR,
          Math.min(MAX_SIDEBAR, drag.startWidth + dx)
        );
        latestWidth = next;
        document.documentElement.style.setProperty('--shell-sidebar-w', `${next}px`);
      };

      const onUp = (): void => {
        sidebarResizeDragRef.current = null;
        document.body.classList.remove('is-resizing');
        handleEl.classList.remove('is-dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        void updateSettings({ sidebarWidth: latestWidth });
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [settings.sidebarWidth, updateSettings]
  );

  // Issue #337: ダブルクリックで default 幅にリセット
  const handleSidebarResizeDouble = useCallback(() => {
    document.documentElement.style.setProperty('--shell-sidebar-w', `${DEFAULT_SIDEBAR}px`);
    void updateSettings({ sidebarWidth: DEFAULT_SIDEBAR });
  }, [updateSettings]);

  const dirtyEditorTabs = useMemo(
    () => editorTabs.filter((tab) => !tab.isBinary && tab.content !== tab.originalContent),
    [editorTabs]
  );

  const confirmDiscardEditorTabs = useCallback(
    (tabIds?: string[]): boolean => {
      const targets =
        tabIds && tabIds.length > 0
          ? dirtyEditorTabs.filter((tab) => tabIds.includes(tab.id))
          : dirtyEditorTabs;
      if (targets.length === 0) return true;
      if (targets.length === 1) {
        return window.confirm(t('editor.discardSingle', { path: targets[0].relPath }));
      }
      return window.confirm(t('editor.discardMultiple', { count: targets.length }));
    },
    [dirtyEditorTabs, t]
  );

  // Phase 1-1 (Issue #373): loadProject / 初回ロード effect / タイトルバー effect /
  // refreshGit は use-project-loader.ts に移管済み。
  // confirmDiscardEditorTabs / onProjectSwitched / onLoaded を hook に橋渡しする。
  confirmDiscardRef.current = confirmDiscardEditorTabs;
  projectSwitchedRef.current = (root: string): void => {
    // タブ・セッション状態をリセット
    setDiffTabs([]);
    setEditorTabs([]);
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
        teamHistoryMemberIdx: null,
        label: 'Claude #1',
        customLabel: null
      }
    ]);
    setActiveTerminalTabId(newId);
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

  const refreshTeamHistory = useCallback(async () => {
    if (!projectRoot) return;
    if (!window.api.teamHistory) return; // preload が古い場合はスキップ
    try {
      const entries = await window.api.teamHistory.list(projectRoot);
      setTeamHistoryEntries(entries);
    } catch (err) {
      console.warn('[teamHistory] list failed:', err);
    }
  }, [projectRoot]);

  // プロジェクト変更時にチーム履歴もロード
  useEffect(() => {
    void refreshTeamHistory();
  }, [refreshTeamHistory]);

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
        // Issue #19: rename の場合は HEAD 側を originalPath から引く
        const result = await window.api.git.diff(projectRoot, file.path, file.originalPath);
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

  const refreshDiffTabsForPath = useCallback(
    async (relPath: string) => {
      if (!projectRoot) return;
      if (!diffTabs.some((tab) => tab.relPath === relPath)) return;
      // Issue #19: rename entry なら HEAD 側を引くため originalPath を同時に渡す
      const originalPath = gitStatus?.files.find((f) => f.path === relPath)?.originalPath;
      try {
        const result = await window.api.git.diff(projectRoot, relPath, originalPath);
        setDiffTabs((prev) =>
          prev.map((tab) =>
            tab.relPath === relPath ? { ...tab, result, loading: false } : tab
          )
        );
      } catch (err) {
        setDiffTabs((prev) =>
          prev.map((tab) =>
            tab.relPath === relPath
              ? {
                  ...tab,
                  loading: false,
                  result: {
                    ok: false,
                    error: String(err),
                    path: relPath,
                    isNew: false,
                    isDeleted: false,
                    isBinary: false,
                    original: '',
                    modified: ''
                  }
                }
              : tab
          )
        );
      }
    },
    [projectRoot, diffTabs, gitStatus]
  );

  // Issue #66: fs watcher の callback が ref 経由で最新 refresh 関数を引けるように同期
  fsWatchHandlersRef.current = {
    refreshGit,
    refreshDiffTabsForPath,
    diffTabs
  };

  // ---------- エディタタブ ----------

  const openEditorTab = useCallback(
    async (rootPath: string, relPath: string) => {
      const effectiveRoot = rootPath || projectRoot;
      if (!effectiveRoot) return;
      // Issue #4: 同じ相対パスが別ルートに存在しうるので id に root も混ぜる
      const id = `edit:${effectiveRoot}\u0001${relPath}`;
      setActiveTabId(id);
      setEditorTabs((prev) => {
        if (prev.some((t) => t.id === id)) return prev;
        return [
          ...prev,
          {
            id,
            rootPath: effectiveRoot,
            relPath,
            content: '',
            originalContent: '',
            isBinary: false,
            lossyEncoding: false,
            encoding: 'utf-8',
            loading: true,
            error: null,
            pinned: false
          }
        ];
      });
      try {
        const res = await window.api.files.read(effectiveRoot, relPath);
        const lossy = res.encoding === 'lossy';
        // Issue #35: lossy 読み込み時はユーザーに明示的に通知する
        if (lossy) {
          showToast(
            t('editor.nonUtf8Warning', { path: relPath }),
            { tone: 'warning' }
          );
        }
        setEditorTabs((prev) =>
          prev.map((tab) =>
            tab.id === id
              ? {
                  ...tab,
                  loading: false,
                  error: res.ok ? null : res.error ?? 'error',
                  content: res.content,
                  originalContent: res.content,
                  isBinary: res.isBinary,
                  lossyEncoding: lossy,
                  encoding: res.encoding || 'utf-8',
                  mtimeMs: res.mtimeMs,
                  sizeBytes: res.sizeBytes,
                  contentHash: res.contentHash
                }
              : tab
          )
        );
      } catch (err) {
        setEditorTabs((prev) =>
          prev.map((tab) =>
            tab.id === id ? { ...tab, loading: false, error: String(err) } : tab
          )
        );
      }
    },
    [projectRoot, showToast, t]
  );

  const updateEditorContent = useCallback((id: string, content: string) => {
    setEditorTabs((prev) =>
      prev.map((t) => (t.id === id ? { ...t, content } : t))
    );
  }, []);

  const saveEditorTab = useCallback(
    async (id: string) => {
      const tab = editorTabs.find((t) => t.id === id);
      if (!tab) return;
      const targetRoot = tab.rootPath || projectRoot;
      if (!targetRoot) return;
      if (tab.isBinary) return;
      // Issue #35: lossy で読み込んだ (非 UTF-8) タブは UTF-8 書き戻すと元 encoding を失う。
      // 保存を拒否し、ユーザーに明示する。
      if (tab.lossyEncoding) {
        showToast(t('editor.nonUtf8SaveBlocked', { path: tab.relPath }), { tone: 'warning' });
        return;
      }
      if (tab.content === tab.originalContent) return;
      try {
        // Issue #65 / #104 / #102 / #119: mtime + size + encoding + content_hash を渡して、
        // 同サイズかつ秒精度で見逃す外部変更も内容ハッシュで検出する。
        let res = await window.api.files.write(
          targetRoot,
          tab.relPath,
          tab.content,
          tab.mtimeMs,
          tab.sizeBytes,
          tab.encoding,
          tab.contentHash
        );
        if (res.conflict) {
          // ユーザーに確認 → OK なら再度 mtime/size/hash チェック無しで書き込む
          const overwrite = window.confirm(
            t('editor.externalChangeConfirm', { path: tab.relPath })
          );
          if (!overwrite) {
            showToast(t('editor.saveAborted', { path: tab.relPath }), { tone: 'warning' });
            return;
          }
          res = await window.api.files.write(
            targetRoot,
            tab.relPath,
            tab.content,
            undefined,
            undefined,
            tab.encoding,
            undefined
          );
        }
        if (res.ok) {
          setEditorTabs((prev) =>
            prev.map((t) =>
              t.id === id
                ? {
                    ...t,
                    originalContent: t.content,
                    mtimeMs: res.mtimeMs,
                    sizeBytes: res.sizeBytes,
                    contentHash: res.contentHash
                  }
                : t
            )
          );
          showToast(t('editor.saved', { path: tab.relPath }), { tone: 'success' });
          void refreshGit();
          void refreshDiffTabsForPath(tab.relPath);
        } else {
          showToast(t('editor.saveFailed', { error: res.error ?? 'error' }), {
            tone: 'error'
          });
        }
      } catch (err) {
        showToast(t('editor.saveFailed', { error: String(err) }), { tone: 'error' });
      }
    },
    [projectRoot, editorTabs, refreshDiffTabsForPath, refreshGit, showToast, t]
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

  // ---------- タブ操作 ----------

  const closeTab = useCallback(
    (id: string) => {
      if (id.startsWith('edit:')) {
        setEditorTabs((prev) => {
          const target = prev.find((t) => t.id === id);
          if (!target || target.pinned) return prev;
          if (
            !target.isBinary &&
            target.content !== target.originalContent &&
            !confirmDiscardEditorTabs([id])
          ) {
            return prev;
          }
          const next = prev.filter((t) => t.id !== id);
          if (activeTabId === id) {
            // 残ったエディタ or 差分タブのうち末尾を選択
            const fallback =
              next.length > 0 ? next[next.length - 1].id : diffTabs[diffTabs.length - 1]?.id ?? null;
            setActiveTabId(fallback);
          }
          return next;
        });
        return;
      }
      setDiffTabs((prev) => {
        const target = prev.find((t) => t.id === id);
        if (!target || target.pinned) return prev;
        setRecentlyClosed((rc) =>
          [target, ...rc.filter((r) => r.id !== id)].slice(0, 10)
        );
        const next = prev.filter((t) => t.id !== id);
        if (activeTabId === id) {
          const fallback =
            next.length > 0 ? next[next.length - 1].id : editorTabs[editorTabs.length - 1]?.id ?? null;
          setActiveTabId(fallback);
        }
        return next;
      });
    },
    [activeTabId, confirmDiscardEditorTabs, diffTabs, editorTabs]
  );

  const togglePin = useCallback((id: string) => {
    if (id.startsWith('edit:')) {
      setEditorTabs((prev) =>
        prev.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t))
      );
      return;
    }
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
      const allIds = [
        ...diffTabs.map((t) => t.id),
        ...editorTabs.map((t) => t.id)
      ];
      if (allIds.length === 0) return;
      const idx = activeTabId ? allIds.indexOf(activeTabId) : -1;
      const next = ((idx < 0 ? 0 : idx) + direction + allIds.length) % allIds.length;
      setActiveTabId(allIds[next]);
    },
    [activeTabId, diffTabs, editorTabs]
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

  // ---------- コマンドパレット ----------

  const commands = useMemo<Command[]>(() => {
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
    const list: Command[] = [
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
        when: () => diffTabs.length > 0,
        run: () => cycleTab(1)
      },
      {
        id: 'view.prevTab',
        title: t('cmd.view.prevTab'),
        subtitle: 'Ctrl+Shift+Tab',
        category: CAT.view,
        when: () => diffTabs.length > 0,
        run: () => cycleTab(-1)
      },
      {
        id: 'tab.close',
        title: t('cmd.tab.close'),
        subtitle: 'Ctrl+W',
        category: CAT.tab,
        when: () => !!activeTabId,
        run: () => { if (activeTabId) closeTab(activeTabId); }
      },
      {
        id: 'tab.reopen',
        title: t('cmd.tab.reopen'),
        subtitle: 'Ctrl+Shift+T',
        category: CAT.tab,
        when: () => recentlyClosed.length > 0,
        run: () => reopenLastClosed()
      },
      {
        id: 'tab.togglePin',
        title: t('cmd.tab.togglePin'),
        category: CAT.tab,
        when: () => !!activeTabId,
        run: () => { if (activeTabId) togglePin(activeTabId); }
      },
      {
        id: 'git.refresh',
        title: t('cmd.git.refresh'),
        category: CAT.git,
        run: () => refreshGit()
      },
      {
        id: 'sessions.refresh',
        title: t('cmd.sessions.refresh'),
        category: CAT.sessions,
        run: () => refreshSessions()
      },
      {
        id: 'terminal.addClaude',
        title: t('cmd.terminal.addClaude'),
        subtitle: `${terminalTabs.length}/${MAX_TERMINALS}`,
        category: CAT.terminal,
        when: () => terminalTabs.length < MAX_TERMINALS,
        run: () => { addTerminalTab({ agent: 'claude' }); }
      },
      {
        id: 'terminal.addCodex',
        title: t('cmd.terminal.addCodex'),
        subtitle: `${terminalTabs.length}/${MAX_TERMINALS}`,
        category: CAT.terminal,
        when: () => terminalTabs.length < MAX_TERMINALS,
        run: () => { addTerminalTab({ agent: 'codex' }); }
      },
      {
        id: 'terminal.closeTab',
        title: t('cmd.terminal.closeTab'),
        category: CAT.terminal,
        when: () => terminalTabs.length > 1,
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
          void import('./lib/updater-check').then((m) => {
            // manual=true: didCheck を無視して再試行可能 + 「最新です」も明示通知
            void m.checkForUpdates({
              language: settings.language,
              showToast,
              dismissToast,
              manual: true,
              runningTaskCount: terminalTabs.length
            });
          });
        }
      }
    ];
    return list;
  }, [
    t,
    handleNewProject,
    handleOpenFolder,
    handleOpenFile,
    handleOpenRecent,
    handleAddWorkspaceFolder,
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
    settings.language,
    updateSettings,
    handleRestart,
    restartTerminal,
    addTerminalTab,
    closeTerminalTab,
    activeTerminalTabId,
    terminalTabs.length,
    diffTabs.length,
    showToast,
    dismissToast
  ]);

  // ---------- Shift+ホイールで webview zoom ----------
  // webviewZoom (factor 0.5-3.0) に委譲。Ctrl+=/-/0 と同じ値を共有するので
  // 両方の経路を混ぜて操作しても状態が食い違わない。
  useEffect(() => {
    const handler = (e: WheelEvent): void => {
      if (!e.shiftKey) return;
      e.preventDefault();
      webviewZoom.adjust(e.deltaY > 0 ? -webviewZoom.STEP : webviewZoom.STEP);
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
      // Issue #162: Ctrl+Shift+P (パレット toggle) と Ctrl+, (設定) は modal open 中でも
      // 反応してよい (toggle 用途のため)。それ以外のショートカット (Ctrl+S / Ctrl+Tab /
      // Ctrl+W / Ctrl+Shift+T) は modal/palette open 中はブロックする。
      const modalIsOpen = paletteOpen || settingsOpen;
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
      if (modalIsOpen) {
        // 以降の保存・タブ切替・タブ閉じはブロック
        return;
      }
      if (!e.shiftKey && (e.key === 's' || e.key === 'S')) {
        if (activeTabId && activeTabId.startsWith('edit:')) {
          e.preventDefault();
          e.stopPropagation();
          void saveEditorTab(activeTabId);
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
        // Issue #38: フォーカスが xterm (Claude / Codex / シェル) の中にあるときは
        // Ctrl+W を「直前の単語を削除」として PTY に素通しさせる。
        const active = document.activeElement as HTMLElement | null;
        const inTerminal = active?.closest?.('.xterm') !== undefined &&
          active?.closest?.('.xterm') !== null;
        if (!inTerminal && activeTabId) {
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
  }, [paletteOpen, settingsOpen, activeTabId, cycleTab, closeTab, reopenLastClosed, saveEditorTab]);

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
      // Claude のチーム指示は --append-system-prompt で直接渡す。
      if (!isCodex && tab.teamId) {
        const team = teams.find((t) => t.id === tab.teamId) ?? null;
        const sysPrompt = generateTeamSystemPrompt(tab, terminalTabs, team);
        if (sysPrompt) {
          base.push('--append-system-prompt', sysPrompt);
        }
      }
      // Codex の paste_burst 検出を無効化する。
      // チーム通信では team_send が chat_composer に文字列を直接流し込むが、
      // Codex は高速連続入力を「ペースト扱い」にバッファしてしまい、
      // 末尾の Enter が送信ではなく確定として飲み込まれて返信できなくなる。
      // ユーザが codexArgs で明示的に設定している場合はそちらを尊重する。
      const userCodexArgs = settings.codexArgs || '';
      if (isCodex && tab.teamId && !userCodexArgs.includes('disable_paste_burst')) {
        base.push('-c', 'disable_paste_burst=true');
      }
      return base;
    },
    [settings.claudeArgs, settings.codexArgs, teams, terminalTabs]
  );

  /**
   * Codex 向けのシステム指示。main 側で一時ファイルに書き出されて
   * `-c model_instructions_file=<path>` として渡される。
   */
  const getCodexInstructions = useCallback(
    (tab: TerminalTab): string | undefined => {
      if (tab.agent !== 'codex' || !tab.teamId) return undefined;
      const team = teams.find((t) => t.id === tab.teamId) ?? null;
      return generateTeamSystemPrompt(tab, terminalTabs, team);
    },
    [teams, terminalTabs]
  );

  /** TeamHub 接続情報（アプリ起動時に1回だけ解決） */
  const [teamHubInfo, setTeamHubInfo] = useState<{ socket: string; token: string } | null>(null);
  useEffect(() => {
    void window.api.app.getTeamHubInfo().then((info) => setTeamHubInfo(info));
  }, []);

  const getTerminalEnv = useCallback(
    (tab: TerminalTab): Record<string, string> | undefined => {
      if (!tab.teamId || !tab.role) return undefined;
      if (!teamHubInfo) return undefined;
      return {
        VIBE_TEAM_ID: tab.teamId,
        VIBE_TEAM_ROLE: tab.role,
        VIBE_AGENT_ID: tab.agentId,
        VIBE_TEAM_SOCKET: teamHubInfo.socket,
        VIBE_TEAM_TOKEN: teamHubInfo.token
      };
    },
    [teamHubInfo]
  );

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

  // 初回タブ作成: Claude OK かつ projectRoot 設定済みでタブなし。
  // Canvas モードでは App は不可視の裏マウントなので、ここでターミナルを生やすと
  // Rust 側で無駄な PTY が常駐し、IDE へ切り替えたときにも "迷子ターミナル" として現れる。
  // → viewMode === 'ide' のときだけ自動生成する。
  useEffect(() => {
    if (
      claudeCheck.state === 'ok' &&
      projectRoot &&
      terminalTabs.length === 0 &&
      viewMode === 'ide'
    ) {
      addTerminalTab();
    }
  }, [claudeCheck.state, projectRoot, terminalTabs.length, addTerminalTab, viewMode]);

  // ---------- チーム履歴の resume / 削除 ----------

  const handleResumeTeam = useCallback(
    async (entry: TeamHistoryEntry) => {
      if (!projectRoot) return;
      if (!entry.members || entry.members.length === 0) {
        showToast('チームメンバー情報が空のため復元できません', { tone: 'warning' });
        return;
      }
      if (entry.projectRoot && entry.projectRoot !== projectRoot) {
        showToast(
          `このチームは別プロジェクト(${entry.projectRoot.split(/[\\/]/).pop()})の履歴です`,
          { tone: 'warning' }
        );
        return;
      }
      // 容量チェック: 既存タブ + メンバー数 が上限を超えるなら断念
      if (terminalTabs.length + entry.members.length > MAX_TERMINALS) {
        showToast(`ターミナル上限(${MAX_TERMINALS})を超えるため復元できません`, {
          tone: 'warning'
        });
        return;
      }

      // 再利用時刻を更新
      const updated: TeamHistoryEntry = {
        ...entry,
        lastUsedAt: new Date().toISOString()
      };
      setTeamHistoryEntries((prev) => [
        updated,
        ...prev.filter((e) => e.id !== entry.id)
      ]);
      saveTeamHistory(updated);

      // ランタイム Team として登録（既に同じ teamId があればそのまま）
      setTeams((prev) =>
        prev.some((t) => t.id === entry.id)
          ? prev
          : [...prev, { id: entry.id, name: entry.name }]
      );

      // MCP は現行の TeamHub 情報で確実に再登録する
      const allMembers = entry.members.map((m, i) => ({
        agentId: `${entry.id}-${m.role}-${i}`,
        role: m.role,
        agent: m.agent
      }));
      let mcpChanged = false;
      if (settings.mcpAutoSetup !== false) {
        try {
          const res = await window.api.app.setupTeamMcp(projectRoot, entry.id, entry.name, allMembers);
          mcpChanged = res.changed === true;
        } catch (err) {
          console.warn('[resume team] setupTeamMcp failed:', err);
        }
      }
      if (mcpChanged) {
        setTerminalTabs((prev) =>
          prev.map((tab) =>
            tab.agent === 'claude' && !tab.exited
              ? { ...tab, version: tab.version + 1, status: '' }
              : tab
          )
        );
      }

      // 各メンバーをタブとしてスポーン（sessionId があれば --resume 付き、customLabel があれば復元）
      for (let i = 0; i < entry.members.length; i++) {
        const m = entry.members[i];
        addTerminalTab({
          agent: m.agent,
          role: m.role,
          teamId: entry.id,
          agentId: allMembers[i].agentId,
          resumeSessionId: m.sessionId ?? null,
          teamHistoryMemberIdx: i,
          customLabel: m.customLabel ?? null
        });
      }

      showToast(t('teamHistory.resumed', { name: entry.name }), { tone: 'info' });
    },
    [projectRoot, terminalTabs.length, addTerminalTab, showToast, t, saveTeamHistory]
  );

  const handleDeleteTeamHistory = useCallback(
    async (entryId: string) => {
      setTeamHistoryEntries((prev) => prev.filter((e) => e.id !== entryId));
      if (!window.api.teamHistory) return;
      try {
        await window.api.teamHistory.delete(entryId);
      } catch (err) {
        console.warn('[teamHistory] delete failed:', err);
      }
    },
    []
  );

  /**
   * Leader だけ閉じる(メンバーはチーム無しタブとして残す)パス。
   * doCloseTeam() と違って tabs は保持するが、"チームは終了" という意味で
   * MCP の参照カウントは減らす必要がある。
   */
  const handleCloseLeaderOnly = useCallback(
    (tabId: number, teamId: string) => {
      // 1) Leader タブだけ閉じる
      doCloseTab(tabId);
      // 2) 残りメンバーは通常タブへ降格(teamId/role を外す)
      setTerminalTabs((prev) =>
        prev.map((tab) =>
          tab.teamId === teamId
            ? { ...tab, teamId: null, role: null, teamHistoryMemberIdx: null }
            : tab
        )
      );
      // 3) runtime チームを削除
      setTeams((prev) => prev.filter((x) => x.id !== teamId));
      // 4) MCP 参照カウントを減らす(doCloseTeam 相当だが spawnStaggerTimers は触らない)
      if (projectRoot) {
        void window.api.app
          .cleanupTeamMcp(projectRoot, teamId)
          .catch((err) => console.warn('[team] cleanup after closeLeaderOnly failed:', err));
      }
    },
    [doCloseTab, projectRoot]
  );

  /**
   * Claude Code 起動ログから session id が取れたときに該当タブのチーム履歴を更新。
   * NOTE: このコールバックは watcher 由来の非同期で、タブが既に閉じられた後に
   * 発火することがある。その場合 tab.teamId は残っているが entry 側は削除済みで
   * findIndex が -1 を返すので no-op。setEditorTabs などに波及しない。
   */
  const handleTerminalSessionId = useCallback(
    (tab: TerminalTab, sessionId: string) => {
      if (!tab.teamId || tab.teamHistoryMemberIdx == null) return;
      if (!sessionId) return;
      setTeamHistoryEntries((prev) => {
        const idx = prev.findIndex((e) => e.id === tab.teamId);
        if (idx < 0) return prev;
        const entry = prev[idx];
        const memberIdx = tab.teamHistoryMemberIdx!;
        if (memberIdx < 0 || memberIdx >= entry.members.length) return prev;
        if (entry.members[memberIdx].sessionId === sessionId) return prev;
        const nextMembers = entry.members.map((m, i) =>
          i === memberIdx ? { ...m, sessionId } : m
        );
        const nextEntry: TeamHistoryEntry = {
          ...entry,
          members: nextMembers,
          lastUsedAt: new Date().toISOString()
        };
        saveTeamHistory(nextEntry);
        const copy = [...prev];
        copy[idx] = nextEntry;
        return copy;
      });
    },
    [saveTeamHistory]
  );

  /**
   * タブの手動リネーム結果を team-history に反映する。
   * チーム所属タブのみ対象。スタンドアロンタブはメモリ揮発なのでスキップ。
   * trimmed が空文字なら customLabel = null (= 自動生成名へ復帰) として保存。
   */
  const persistTerminalCustomLabel = useCallback(
    (tab: TerminalTab, trimmed: string) => {
      if (!tab.teamId || tab.teamHistoryMemberIdx == null) return;
      const next: string | null = trimmed === '' ? null : trimmed;
      setTeamHistoryEntries((prev) => {
        const idx = prev.findIndex((e) => e.id === tab.teamId);
        if (idx < 0) return prev;
        const entry = prev[idx];
        const memberIdx = tab.teamHistoryMemberIdx!;
        if (memberIdx < 0 || memberIdx >= entry.members.length) return prev;
        if ((entry.members[memberIdx].customLabel ?? null) === next) return prev;
        const nextMembers = entry.members.map((m, i) =>
          i === memberIdx ? { ...m, customLabel: next } : m
        );
        const nextEntry: TeamHistoryEntry = {
          ...entry,
          members: nextMembers,
          lastUsedAt: new Date().toISOString()
        };
        saveTeamHistory(nextEntry);
        const copy = [...prev];
        copy[idx] = nextEntry;
        return copy;
      });
    },
    [saveTeamHistory]
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
        historyCount={totalHistoryCount}
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
        onMouseDown={handleSidebarResizeStart}
        onDoubleClick={handleSidebarResizeDouble}
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
          onMouseDown={handleResizeStart}
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

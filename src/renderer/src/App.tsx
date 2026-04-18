import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Command as CommandIcon, Crown, Plus, RotateCw, Settings as SettingsIcon, Users } from 'lucide-react';
import type {
  GitDiffResult,
  GitFileChange,
  GitStatus,
  SessionInfo,
  Team,
  TeamHistoryEntry,
  TeamMember,
  TeamPreset,
  TeamRole,
  TerminalAgent,
  ThemeName
} from '../../types/shared';
import { Sidebar, type SidebarView } from './components/Sidebar';
import { TabBar, type TabItem } from './components/TabBar';
import { Toolbar } from './components/Toolbar';
import { DiffView } from './components/DiffView';
import { EditorView } from './components/EditorView';
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
  /** Issue #65: 開いた時点の mtime (ms since epoch)。save 時の external-change 検出に使う */
  mtimeMs?: number;
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
  hasActivity: boolean;
  /** チーム履歴で使う member インデックス。未所属タブは null */
  teamHistoryMemberIdx: number | null;
  /** ユーザー向け表示ラベル（自動生成 or 手動リネーム） */
  label: string;
}

/** ロール別の短い説明（チームプロンプト内で使用） */
const ROLE_DESC: Record<TeamRole, string> = {
  leader: '全体の調整・指示・タスク割り振り',
  planner: '実装計画の作成・タスク分解・アーキテクチャ設計',
  programmer: '計画に基づいた高品質なコード実装',
  researcher: 'コードベース調査・ドキュメント確認・API調査',
  reviewer: 'コードレビュー・バグ特定・改善提案'
};

/** ロスター表示用の固定順。並び替えの影響を受けないようにする */
const ROLE_ORDER: Record<string, number> = {
  leader: 0,
  planner: 1,
  programmer: 2,
  researcher: 3,
  reviewer: 4
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
    'MCP vibe-team ツール: team_send(to,message) / team_assign_task(assignee,description) / team_get_tasks() / team_update_task(task_id,status) / team_info() / team_status(status) / team_read(). ' +
    'team_send/team_assign_task で送ったメッセージは相手のプロンプトにリアルタイム注入されるので、受信側はポーリング不要。受信時は [Team ← <role>] プレフィックス付きで入力に届く。';

  if (tab.role === 'leader') {
    return `あなたはチーム「${team.name}」のLeader。構成: ${roster}。${mcpTools} 重要: ユーザーから最初の指示が来るまで何もせず待機してください。自分からプロジェクト調査やタスク割振を開始してはいけません。ユーザー指示を受け取ってから、1)必要に応じて調査 2)計画立案 3)team_assign_taskで割振 4)結果は [Team ← ...] で届くので都度レビューし team_send で追指示 の順で進めてください。`;
  }

  return `あなたはチーム「${team.name}」の${tab.role}。役割:${ROLE_DESC[tab.role]}。構成: ${roster}。${mcpTools} 重要: Leaderからの指示を受け取るまで何もせず待機してください。自分からプロジェクト調査やコード変更を始めてはいけません。Leaderからの指示は [Team ← leader] 形式で入力に届くので、それを受け取ってから作業を開始し、完了後は team_send('leader', ...) で報告してください。`;
}

/** 短いアクション指示（initialMessage 用）。
 *  チーム所属タブは全員「待機」が基本方針なので何も送らない。
 *  Leader はユーザーからの最初の指示を待ち、メンバーは Leader からの注入を待つ。 */
function generateTeamAction(_tab: TerminalTab): string | undefined {
  return undefined;
}

export function App(): JSX.Element {
  const {
    settings,
    loading: settingsLoading,
    update: updateSettings,
    reset: resetSettings
  } = useSettings();
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
  const [tabCreateMenuOpen, setTabCreateMenuOpen] = useState(false);
  const [teamModalOpen, setTeamModalOpen] = useState(false);
  const [teams, setTeams] = useState<Team[]>([]);
  const [pendingTeamClose, setPendingTeamClose] = useState<{
    tabId: number;
    teamId: string;
  } | null>(null);
  const [dragTabId, setDragTabId] = useState<number | null>(null);
  const [dragOverTabId, setDragOverTabId] = useState<number | null>(null);
  const [editingLabelTabId, setEditingLabelTabId] = useState<number | null>(null);

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
          hasActivity: false,
          teamHistoryMemberIdx: opts?.teamHistoryMemberIdx ?? null,
          label
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
          hasActivity: false,
          teamHistoryMemberIdx: null,
          label: 'Claude #1'
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
            hasActivity: false,
            teamHistoryMemberIdx: null,
            label: 'Claude #1'
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

  // 起動時に GitHub Release の latest.json を確認 (prod のみ)
  useEffect(() => {
    void import('./lib/updater-check').then((m) => m.checkForUpdatesOnce());
  }, []);

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

  /** 指定ルートでプロジェクトを読み込み直す */
  const loadProject = useCallback(
    async (root: string, options: { addToRecent?: boolean } = { addToRecent: true }) => {
      if (projectRoot && projectRoot !== root && !confirmDiscardEditorTabs()) {
        return false;
      }
      setProjectRoot(root);
      setStatus('プロジェクト読み込み中…');
      setGitLoading(true);

      try {
        const [gs, sess] = await Promise.all([
          window.api.git.status(root),
          window.api.sessions.list(root)
        ]);
        // MCP 初期化は await する（新規タブ spawn より前に claude.json を確定）
        try {
          await window.api.app.setupTeamMcp(root, '_init', '', []);
        } catch (err) {
          console.warn('[loadProject] setupTeamMcp failed:', err);
        }

        setGitStatus(gs);
        setSessions(sess);
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
            hasActivity: false,
            teamHistoryMemberIdx: null,
            label: 'Claude #1'
          }
        ]);
        setActiveTerminalTabId(newId);
        setStatus(`${root.split(/[\\/]/).pop()}`);
        // ここでは runtime の「最後に開いたルート」のみ永続化する。
        // `claudeCwd` は SettingsModal で設定されるユーザー設定のため上書き厳禁。
        if (options.addToRecent !== false) {
          const rp = settings.recentProjects ?? [];
          const next = [root, ...rp.filter((p) => p !== root)].slice(0, 10);
          void updateSettings({ recentProjects: next, lastOpenedRoot: root });
        } else {
          void updateSettings({ lastOpenedRoot: root });
        }
        return true;
      } catch (err) {
        setStatus(`読み込みエラー: ${String(err)}`);
        return false;
      } finally {
        setGitLoading(false);
      }
    },
    [projectRoot, confirmDiscardEditorTabs, settings.recentProjects, updateSettings]
  );

  // 初回ロード — lastOpenedRoot (前回開いたルート) があれば復元、なければ process.cwd()。
  // settings の非同期 hydration を待ってから走らせないと、DEFAULT_SETTINGS の
  // 空文字を読み取って process.cwd() に fallback し、結果として永続値を失ってしまう。
  const didInitRef = useRef(false);
  useEffect(() => {
    if (settingsLoading) return;
    if (didInitRef.current) return;
    didInitRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        // 既存ユーザーの移行: lastOpenedRoot が空で claudeCwd が設定されている場合は
        // かつての挙動 (claudeCwd = 最後に開いたルート) を尊重して再利用する。
        const remembered = settings.lastOpenedRoot || settings.claudeCwd;
        const root = remembered || (await window.api.app.getProjectRoot());
        if (cancelled) return;
        setProjectRoot(root);
        if (!settings.lastOpenedRoot) {
          void updateSettings({ lastOpenedRoot: root });
        }
        const [gs, sess] = await Promise.all([
          window.api.git.status(root),
          window.api.sessions.list(root)
        ]);
        // MCP 初期化は await する（新規タブ spawn より前に claude.json を確定）
        try {
          await window.api.app.setupTeamMcp(root, '_init', '', []);
        } catch (err) {
          console.warn('[init] setupTeamMcp failed:', err);
        }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsLoading]);

  // タイトルバー
  useEffect(() => {
    const name = projectRoot.split(/[\\/]/).pop() || 'vibe-editor';
    window.api.app.setWindowTitle(`vibe-editor — ${name}`).catch(() => undefined);
  }, [projectRoot]);

  const handleRestart = useCallback(async () => {
    if (dirtyEditorTabs.length > 0 && !window.confirm(t('editor.restartConfirm'))) {
      return;
    }
    await window.api.app.restart();
  }, [dirtyEditorTabs.length, t]);

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
                  mtimeMs: res.mtimeMs
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
        // Issue #65: expectedMtimeMs を渡し、外部変更があれば conflict=true で弾かれる
        let res = await window.api.files.write(
          targetRoot,
          tab.relPath,
          tab.content,
          tab.mtimeMs
        );
        if (res.conflict) {
          // ユーザーに確認 → OK なら再度 mtime チェック無しで書き込む
          const overwrite = window.confirm(
            t('editor.externalChangeConfirm', { path: tab.relPath })
          );
          if (!overwrite) {
            showToast(t('editor.saveAborted', { path: tab.relPath }), { tone: 'warning' });
            return;
          }
          res = await window.api.files.write(targetRoot, tab.relPath, tab.content);
        }
        if (res.ok) {
          setEditorTabs((prev) =>
            prev.map((t) =>
              t.id === id
                ? { ...t, originalContent: t.content, mtimeMs: res.mtimeMs }
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
    const folder = await window.api.dialog.openFolder('ワークスペースに追加するフォルダを選択');
    if (!folder) return;
    const name = folder.split(/[\\/]/).pop() ?? folder;
    if (folder === projectRoot) {
      showToast(t('workspace.alreadyAdded', { name }), { tone: 'info' });
      return;
    }
    const current = settings.workspaceFolders ?? [];
    if (current.includes(folder)) {
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
      {
        id: 'workspace.addFolder',
        title: 'フォルダをワークスペースに追加…',
        category: 'ワークスペース',
        run: () => void handleAddWorkspaceFolder()
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
      if (!e.shiftKey && (e.key === 's' || e.key === 'S')) {
        if (activeTabId && activeTabId.startsWith('edit:')) {
          e.preventDefault();
          e.stopPropagation();
          void saveEditorTab(activeTabId);
        }
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
      if (terminalTabs.length + totalNeeded > MAX_TERMINALS) {
        showToast(`チームは上限 ${MAX_TERMINALS} を超えます`, { tone: 'warning' });
        return;
      }

      const teamId = `team-${Date.now()}`;
      // 同時作成レース対策: これ以前の staggered spawn 予約は全て中断する
      clearSpawnTimers();

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

      // MCP サーバーをセットアップ（Claude Code / Codex MCP 設定）
      let mcpChanged = false;
      if (projectRoot) {
        try {
          const res = await window.api.app.setupTeamMcp(
            projectRoot,
            teamId,
            teamName,
            allMembers
          );
          if (!res?.ok) {
            throw new Error(res?.error || 'setupTeamMcp failed');
          }
          mcpChanged = res.changed === true;
        } catch (err) {
          // 失敗時は予約した状態を全部ロールバックする。
          // ここで続行すると TeamHub 無しでタブだけ生えて "ゾンビチーム" になる。
          console.warn('[team] setupTeamMcp failed:', err);
          setTeams((prev) => prev.filter((t) => t.id !== teamId));
          showToast(
            `チーム作成に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
            { tone: 'error' }
          );
          return;
        }
      }

      // claude.json が更新された場合、既存の Claude タブは古い MCP 情報で起動しているので
      // サイレントに再起動して新しいポート/トークンを読み直させる
      if (mcpChanged) {
        setTerminalTabs((prev) =>
          prev.map((tab) =>
            tab.agent === 'claude' && !tab.exited
              ? { ...tab, version: tab.version + 1, status: '', hasActivity: false }
              : tab
          )
        );
      }

      // チーム履歴エントリを先に作って保存。teamId とレコード ID を一致させ、
      // あとで sessionId が取れたら差分更新する。
      if (projectRoot) {
        const now = new Date().toISOString();
        const entry: TeamHistoryEntry = {
          id: teamId,
          name: teamName,
          projectRoot,
          createdAt: now,
          lastUsedAt: now,
          members: [
            { role: 'leader' as TeamRole, agent: leader.agent, sessionId: null },
            ...members.map((m) => ({
              role: m.role,
              agent: m.agent,
              sessionId: null as string | null
            }))
          ]
        };
        setTeamHistoryEntries((prev) => [
          entry,
          ...prev.filter((e) => e.id !== entry.id)
        ]);
        saveTeamHistory(entry);
      }

      // Leader を先に生成（teamHistoryMemberIdx=0）
      addTerminalTab({
        agent: leader.agent,
        role: 'leader' as TeamRole,
        teamId,
        agentId: allMembers[0].agentId,
        teamHistoryMemberIdx: 0
      });
      // メンバーは少しずつ間隔を空けて生成する（レイアウト確定前に N 個一気に
      // マウントすると、ResizeObserver と fit.fit() の衝突で謎のスペースや
      // 位置ズレが起きることがある。80ms 間隔だとほぼ問題なく落ち着く）
      const SPAWN_STAGGER_MS = 80;
      for (let i = 0; i < members.length; i++) {
        const memberIdx = i + 1;
        const m = members[i];
        const timer = setTimeout(() => {
          addTerminalTab({
            agent: m.agent,
            role: m.role,
            teamId,
            agentId: allMembers[memberIdx].agentId,
            teamHistoryMemberIdx: memberIdx
          });
          // 自分自身を spawnStaggerTimers からも落とす
          spawnStaggerTimers.current = spawnStaggerTimers.current.filter(
            (t) => t !== timer
          );
        }, (i + 1) * SPAWN_STAGGER_MS);
        spawnStaggerTimers.current.push(timer);
      }
    },
    [
      addTerminalTab,
      terminalTabs.length,
      projectRoot,
      saveTeamHistory,
      clearSpawnTimers,
      showToast
    ]
  );

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
      try {
        const res = await window.api.app.setupTeamMcp(projectRoot, entry.id, entry.name, allMembers);
        mcpChanged = res.changed === true;
      } catch (err) {
        console.warn('[resume team] setupTeamMcp failed:', err);
      }
      if (mcpChanged) {
        setTerminalTabs((prev) =>
          prev.map((tab) =>
            tab.agent === 'claude' && !tab.exited
              ? { ...tab, version: tab.version + 1, status: '', hasActivity: false }
              : tab
          )
        );
      }

      // 各メンバーをタブとしてスポーン（sessionId があれば --resume 付き）
      for (let i = 0; i < entry.members.length; i++) {
        const m = entry.members[i];
        addTerminalTab({
          agent: m.agent,
          role: m.role,
          teamId: entry.id,
          agentId: allMembers[i].agentId,
          resumeSessionId: m.sessionId ?? null,
          teamHistoryMemberIdx: i
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

  const projectName = projectRoot.split(/[\\/]/).pop() || 'no project';
  const activeTab = terminalTabs.find((t) => t.id === activeTerminalTabId) ?? null;

  return (
    <div className={`layout${hasActiveContent ? '' : ' layout--terminal-full'}`}>
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
        recentProjects={settings.recentProjects ?? []}
        onNewProject={handleNewProject}
        onOpenFolder={handleOpenFolder}
        onOpenFileDialog={handleOpenFile}
        onOpenRecent={handleOpenRecent}
        onClearRecent={handleClearRecent}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main className="main">
        <Toolbar
          projectRoot={projectRoot}
          onRestart={handleRestart}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenPalette={() => setPaletteOpen(true)}
          status={status}
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
          {activeEditorTab ? (
            <div className="pane">
              <EditorView
                path={activeEditorTab.relPath}
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
                {/* ペインヘッダー（エージェント + ロール + 閉じる） */}
                {(terminalTabs.length > 1 || tab.teamId) && (
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
                        defaultValue={tab.label}
                        autoFocus
                        onClick={(e) => e.stopPropagation()}
                        onBlur={(e) => {
                          const v = e.currentTarget.value.trim() || tab.label;
                          setTerminalTabs((prev) => prev.map((t) => t.id === tab.id ? { ...t, label: v } : t));
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
                        title={tab.label}
                      >
                        {tab.label}
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
                  onExit={() =>
                    setTerminalTabs((prev) =>
                      prev.map((t) => (t.id === tab.id ? { ...t, exited: true } : t))
                    )
                  }
                  onSessionId={(sid) => handleTerminalSessionId(tab, sid)}
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

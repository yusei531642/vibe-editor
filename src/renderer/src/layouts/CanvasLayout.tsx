/**
 * CanvasLayout — Canvas モードのトップレベルレイアウト。
 *
 * Phase 3:
 *   - Workspace Preset セレクタ (BUILTIN_PRESETS から 1 クリックでチーム配置)
 *   - Card 数表示 + Clear
 *   - IDE モードへ戻るボタン
 *
 * Phase 5:
 *   - Preset 起動時に teamHistory に自動保存 (canvasState 込み)
 *   - "Recent Teams" タブで過去チームを再開 (Card 配置完全復元)
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Node } from '@xyflow/react';
import {
  ArrowDownToLine,
  ChevronDown,
  FilePlus,
  FolderTree,
  GitBranch,
  Layout,
  MonitorSmartphone,
  Plus,
  Sparkles,
  History
} from 'lucide-react';
import type { CardData, CardType } from '../stores/canvas';
import type {
  Language,
  HandoffReference,
  TeamHistoryEntry,
  TeamRole,
  TerminalAgent
} from '../../../types/shared';
import { Canvas } from '../components/canvas/Canvas';
import { CanvasSidebar } from '../components/canvas/CanvasSidebar';
import { Rail } from '../components/shell/Rail';
import { WindowControls } from '../components/shell/WindowControls';
import type { SidebarView } from '../components/Sidebar';
import { SettingsModal } from '../components/SettingsModal';
import { useT } from '../lib/i18n';
import { useUiStore } from '../stores/ui';
import { useCanvasStore } from '../stores/canvas';
import {
  BUILTIN_PRESETS,
  DEFAULT_SPAWN_PRESET,
  presetPosition,
  type WorkspacePreset
} from '../lib/workspace-presets';
import { ROLE_META, roleMetaFor } from '../lib/team-roles';
import { useSettings } from '../lib/settings-context';
import { useToast } from '../lib/toast-context';

type Tab = 'preset' | 'recent';

function localeOf(language: Language): string {
  return language === 'ja' ? 'ja-JP' : 'en-US';
}

function formatCardCount(count: number, language: Language): string {
  return language === 'ja'
    ? `${count} 枚のカード`
    : `${count} ${count === 1 ? 'card' : 'cards'}`;
}

function formatAgentCount(count: number, language: Language): string {
  return language === 'ja' ? `${count} エージェント` : `${count} agents`;
}

function mergeCanvasMembers(
  currentMembers: { role: TeamRole; agent: TerminalAgent }[],
  existingEntry?: TeamHistoryEntry
): TeamHistoryEntry['members'] {
  const sessionQueues = new Map<string, Array<string | null>>();
  for (const member of existingEntry?.members ?? []) {
    const key = `${member.role}:${member.agent}`;
    const queue = sessionQueues.get(key) ?? [];
    queue.push(member.sessionId ?? null);
    sessionQueues.set(key, queue);
  }

  return currentMembers.map((member) => {
    const key = `${member.role}:${member.agent}`;
    const queue = sessionQueues.get(key);
    const sessionId = queue && queue.length > 0 ? queue.shift() ?? null : null;
    return { ...member, sessionId };
  });
}

function serializeAutoSavePayload(payload: {
  byTeam: Map<
    string,
    {
      name: string;
      canvasNodes: { agentId: string; x: number; y: number; width?: number; height?: number }[];
      latestHandoff?: HandoffReference;
    }
  >;
  viewport: { x: number; y: number; zoom: number };
}): string {
  const parts: string[] = [];
  for (const [teamId, info] of payload.byTeam) {
    parts.push(
      `${teamId}|${info.name}|` +
        info.canvasNodes
          .map((c) => `${c.agentId}@${c.x},${c.y}:${c.width}x${c.height}`)
          .sort()
          .join(',') +
        `|handoff:${info.latestHandoff?.id ?? ''}:${info.latestHandoff?.status ?? ''}`
    );
  }
  parts.sort();
  return (
    parts.join('##') +
    `##vp:${Math.round(payload.viewport.x)},${Math.round(payload.viewport.y)}:${payload.viewport.zoom.toFixed(2)}`
  );
}

export function CanvasLayout(): JSX.Element {
  const setViewMode = useUiStore((s) => s.setViewMode);
  // bug: 旧実装では main.tsx 側で viewMode === 'canvas' のときだけ CanvasLayout を
  // マウントしていたため、IDE→Canvas→IDE と切替えると Canvas 内の AgentNodeCard が
  // unmount → usePtySession の cleanup が走り PTY が kill されて Claude セッションが
  // 全部消えていた。CanvasLayout を常時マウントし、display:none で隠すことで解決。
  const viewMode = useUiStore((s) => s.viewMode);
  const isCanvasActive = viewMode === 'canvas';
  const cardCount = useCanvasStore((s) => s.nodes.length);
  // Issue #124: ドラッグ中は React Flow が onNodesChange で毎フレーム新しい nodes 配列を
  // commit する。`nodes` を直接 selector で購読すると、CanvasLayout 配下の重い useMemo
  // (autoSavePayload など) が毎フレーム再評価されて 30〜60% CPU を張り付かせる。
  // → ドラッグ完了後 (nodes.some(n => n.dragging) === false) のスナップショットのみを
  //    React state に反映する。team 復元や auto-save はこの「settled」配列を見る。
  const [nodes, setNodes] = useState<Node<CardData>[]>(
    () => useCanvasStore.getState().nodes
  );
  useEffect(() => {
    return useCanvasStore.subscribe((state, prev) => {
      if (state.nodes === prev.nodes) return;
      if (state.nodes.some((n) => n.dragging)) return;
      setNodes(state.nodes);
    });
  }, []);
  const viewport = useCanvasStore((s) => s.viewport);
  const clear = useCanvasStore((s) => s.clear);
  const addCards = useCanvasStore((s) => s.addCards);
  const { settings, update: updateSettings, reset: resetSettings } = useSettings();
  const t = useT();
  // プロジェクトルート: runtime の lastOpenedRoot を優先。ユーザー設定の
  // claudeCwd (明示指定された作業ディレクトリ) は互換フォールバックとして扱う。
  const projectRoot = settings.lastOpenedRoot || settings.claudeCwd || '';
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const availableUpdate = useUiStore((s) => s.availableUpdate);
  const { showToast, dismissToast } = useToast();
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [tab, setTab] = useState<'preset' | 'recent'>('preset');
  const [addCardOpen, setAddCardOpen] = useState(false);
  const [recent, setRecent] = useState<TeamHistoryEntry[]>([]);
  const [sidebarView, setSidebarView] = useState<SidebarView>('files');
  const [railChangeCount, setRailChangeCount] = useState(0);
  const [railHistoryCount, setRailHistoryCount] = useState(0);
  const [railHasGitRepo, setRailHasGitRepo] = useState(true);
  // git リポジトリが無いと判明 + 現在 'changes' を見ている → 'files' に退避
  useEffect(() => {
    if (!railHasGitRepo && sidebarView === 'changes') {
      setSidebarView('files');
    }
  }, [railHasGitRepo, sidebarView]);
  const addPopoverRef = useRef<HTMLDivElement>(null);
  const spawnPopoverRef = useRef<HTMLDivElement>(null);
  const locale = localeOf(settings.language);
  const dateTimeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      }),
    [locale]
  );

  useEffect(() => {
    if (!addCardOpen && !spawnOpen) return;
    const handlePointerDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (addCardOpen && addPopoverRef.current && !addPopoverRef.current.contains(target)) {
        setAddCardOpen(false);
      }
      if (spawnOpen && spawnPopoverRef.current && !spawnPopoverRef.current.contains(target)) {
        setSpawnOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setAddCardOpen(false);
        setSpawnOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [addCardOpen, spawnOpen]);

  // Recent ロード
  const loadRecent = async (): Promise<void> => {
    if (!projectRoot) return;
    try {
      const list = await window.api.teamHistory.list(projectRoot);
      setRecent(list);
    } catch (err) {
      console.warn('[recent] load failed:', err);
    }
  };
  useEffect(() => {
    void loadRecent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot]);

  // 起動時のチーム復元 — canvas store は zustand persist で localStorage から
  // nodes/viewport が復元されるが、Rust 側 TeamHub は再起動でリセットされるため
  // active_teams が空のまま。各 nodes が持つ teamId をユニーク化して setupTeamMcp を
  // 1 度だけ呼び直し、TeamHub に再登録する。これがないと team_send 等の MCP ツールが
  // 「unregistered team_id」で弾かれ「resume されず新しい状態に見える」原因になる。
  // Issue #159: 旧実装は「成功 / 未試行」の 2 状態しか持たず、失敗 → ref から削除 →
  //   次レンダーで再試行 → 失敗、を毎フレーム繰り返して .claude.json が連射書込される
  //   無限再試行ループに入っていた。in_flight / failed (backoff 中) / done の 3 状態に拡張する。
  type RestoreState = 'in_flight' | 'failed' | 'done';
  const restoredTeamsRef = useRef<Map<string, { state: RestoreState; nextRetryAt?: number }>>(
    new Map()
  );
  useEffect(() => {
    if (nodes.length === 0) {
      // Clear 後は次のチームでまた setup したいので ref をリセット
      restoredTeamsRef.current.clear();
    }
  }, [nodes.length]);
  useEffect(() => {
    if (!projectRoot) return;
    if (settings.mcpAutoSetup === false) return;
    interface TeamRestoreInfo {
      name: string;
      members: { agentId: string; role: string; agent: string }[];
    }
    const byTeam = new Map<string, TeamRestoreInfo>();
    for (const n of nodes) {
      const p = (n.data?.payload ?? {}) as {
        teamId?: string;
        agentId?: string;
        role?: string;
        agent?: string;
      };
      if (!p.teamId || !p.agentId || !p.role || !p.agent) continue;
      const title = String(n.data?.title ?? 'Team');
      const tm = byTeam.get(p.teamId) ?? { name: title, members: [] };
      tm.members.push({ agentId: p.agentId, role: p.role, agent: p.agent });
      byTeam.set(p.teamId, tm);
    }
    const now = Date.now();
    for (const [teamId, info] of byTeam) {
      const cur = restoredTeamsRef.current.get(teamId);
      if (cur?.state === 'in_flight' || cur?.state === 'done') continue;
      // failed バックオフ中なら待機
      if (cur?.state === 'failed' && cur.nextRetryAt && now < cur.nextRetryAt) continue;
      // 進行中状態に登録してから IPC 発射 (重複発火防止)
      restoredTeamsRef.current.set(teamId, { state: 'in_flight' });
      void window.api.app
        .setupTeamMcp(projectRoot, teamId, info.name, info.members)
        .then(() => {
          restoredTeamsRef.current.set(teamId, { state: 'done' });
        })
        .catch((err) => {
          // 30 秒バックオフ。連続失敗時に毎レンダー再投入されるのを防ぐ。
          restoredTeamsRef.current.set(teamId, {
            state: 'failed',
            nextRetryAt: Date.now() + 30_000
          });
          console.warn('[restore] setupTeamMcp failed:', err);
        });
    }
  }, [projectRoot, nodes, settings.mcpAutoSetup]);

  // Phase 5: Canvas state が変わったら、active な team について team-history へ自動保存。
  //
  // パフォーマンス注意:
  //   nodes は zustand で position 変化のたび (drag 中毎フレーム) 参照が変わるため、
  //   この useEffect を [nodes, viewport] に依存させると毎フレーム clearTimeout/setTimeout
  //   が走り、800ms 無操作が続かない限り保存されない (drag 中は永遠に保存されない)。
  //
  // 対策:
  //   1. 保存対象のエントリを JSON stringify で stable key 化し、deps に渡す (string 比較で
  //      早期 bailout)。
  //   2. debounce を 1500ms に延長。
  //   3. 直前保存値を ref に保持し、同一内容なら fs 書き込みをスキップ。
  const lastSavedKeyRef = useRef<string>('');
  // Issue #167: recent を deps に含むと setRecent → effect 再走 → clearTimeout で
  // debounce が永遠に flush されない問題があった。ref 経由で参照することで deps から外す。
  const recentRef = useRef(recent);
  recentRef.current = recent;
  const autoSavePayload = useMemo(() => {
    if (nodes.length === 0) return null;
    interface TeamEntryInfo {
      name: string;
      members: { role: TeamRole; agent: TerminalAgent }[];
      canvasNodes: { agentId: string; x: number; y: number; width?: number; height?: number }[];
      latestHandoff?: HandoffReference;
    }
    const byTeam = new Map<string, TeamEntryInfo>();
    for (const n of nodes) {
      const p = (n.data?.payload ?? {}) as {
        teamId?: string;
        agentId?: string;
        role?: string;
        agent?: string;
        latestHandoff?: HandoffReference;
      };
      if (!p.teamId || !p.agentId) continue;
      const title = String(n.data?.title ?? 'Team');
      const entry = byTeam.get(p.teamId) ?? { name: title, members: [], canvasNodes: [] };
      entry.members.push({
        role: (p.role ?? 'leader') as TeamRole,
        agent: (p.agent ?? 'claude') as TerminalAgent
      });
      entry.canvasNodes.push({
        agentId: p.agentId,
        // 位置は整数に丸めて key の微動を抑える (サブピクセル更新で再保存しない)
        x: Math.round(n.position.x),
        y: Math.round(n.position.y),
        width: typeof n.style?.width === 'number' ? Math.round(n.style.width as number) : undefined,
        height: typeof n.style?.height === 'number' ? Math.round(n.style.height as number) : undefined
      });
      if (p.latestHandoff) {
        const prev = entry.latestHandoff;
        const prevTime = prev?.updatedAt ?? prev?.createdAt ?? '';
        const nextTime = p.latestHandoff.updatedAt ?? p.latestHandoff.createdAt ?? '';
        if (!prev || nextTime >= prevTime) {
          entry.latestHandoff = p.latestHandoff;
        }
      }
      byTeam.set(p.teamId, entry);
    }
    return { byTeam, viewport };
  }, [nodes, viewport]);

  useEffect(() => {
    if (!autoSavePayload) return;
    const autoSaveKey = serializeAutoSavePayload(autoSavePayload);
    if (autoSaveKey === lastSavedKeyRef.current) return;
    const handle = window.setTimeout(() => {
      // debounce タイマー発火時点でも最新 key が変わらなければ保存
      lastSavedKeyRef.current = autoSaveKey;
      const nowIso = new Date().toISOString();
      const nextEntries: TeamHistoryEntry[] = [];
      for (const [teamId, info] of autoSavePayload.byTeam) {
        // Issue #167: recent を ref 経由で参照し effect deps から外す
        const existing = recentRef.current.find((entry) => entry.id === teamId);
        const entry: TeamHistoryEntry = {
          id: teamId,
          name: info.members.length > 0 ? `${info.name} (${info.members.length})` : info.name,
          projectRoot: existing?.projectRoot ?? projectRoot,
          createdAt: existing?.createdAt ?? nowIso,
          lastUsedAt: nowIso,
          members: mergeCanvasMembers(info.members, existing),
          canvasState: { nodes: info.canvasNodes, viewport: autoSavePayload.viewport },
          latestHandoff: info.latestHandoff ?? existing?.latestHandoff
        };
        nextEntries.push(entry);
      }
      // Issue #132: チームごとに save IPC を撃つと N チーム分 N 回 atomic_write が走る。
      // saveBatch で 1 IPC + 1 disk write にまとめる。
      if (nextEntries.length > 0) {
        void window.api.teamHistory.saveBatch(nextEntries).catch((err) => {
          console.warn('[recent] saveBatch failed:', err);
        });
      }
      if (nextEntries.length > 0) {
        setRecent((prev) => {
          const merged = new Map(prev.map((entry) => [entry.id, entry]));
          for (const entry of nextEntries) merged.set(entry.id, entry);
          return Array.from(merged.values()).sort((a, b) =>
            b.lastUsedAt.localeCompare(a.lastUsedAt)
          );
        });
      }
    }, 1500);
    return () => window.clearTimeout(handle);
    // Issue #167: recent を deps から除外。recentRef 経由で読むことで debounce flush を保証する。
  }, [autoSavePayload, projectRoot]);

  const applyPreset = async (preset: WorkspacePreset): Promise<void> => {
    const teamId = `team-${crypto.randomUUID()}`;
    const cwd = projectRoot;
    const presetName = t(preset.i18nKey);
    // Issue #72: setupTeamMcp を addCards より前に完了させる
    if (settings.mcpAutoSetup !== false) {
      try {
        await window.api.app.setupTeamMcp(
          cwd,
          teamId,
          presetName,
          preset.members.map((m, i) => ({
            agentId: `${m.role}-${i}-${teamId}`,
            role: m.role,
            agent: m.agent
          }))
        );
      } catch (err) {
        console.warn('[preset] setupTeamMcp failed:', err);
      }
    }
    const cards = preset.members.map((m, i) => {
      const agentId = `${m.role}-${i}-${teamId}`;
      // Issue #69: 未知 role でもクラッシュしないよう fallback
      const label = ROLE_META[m.role]?.label ?? m.role ?? 'Agent';
      return {
        type: 'agent' as const,
        title: label,
        position: presetPosition(m.col, m.row),
        payload: {
          agent: m.agent,
          role: m.role,
          teamId,
          agentId,
          cwd
        }
      };
    });
    addCards(cards);
    setSpawnOpen(false);
    void loadRecent();
  };

  const restoreRecent = async (entry: TeamHistoryEntry): Promise<void> => {
    const cwd = projectRoot || entry.projectRoot;
    // Issue #72: agent spawn 前に MCP 設定を反映
    if (settings.mcpAutoSetup !== false) {
      try {
        await window.api.app.setupTeamMcp(
          cwd,
          entry.id,
          entry.name,
          entry.members.map((m, i) => ({
            agentId: `${m.role}-${i}-${entry.id}`,
            role: m.role,
            agent: m.agent
          }))
        );
      } catch (err) {
        console.warn('[restore] setupTeamMcp failed:', err);
      }
    }
    const cards = entry.members.map((m, i) => {
      const agentId = `${m.role}-${i}-${entry.id}`;
      const saved = entry.canvasState?.nodes.find((s) => s.agentId === agentId);
      const pos = saved
        ? { x: saved.x, y: saved.y }
        : presetPosition(i % 3, Math.floor(i / 3));
      // Issue #69: 未知 role でも落ちないよう optional chain
      const label = ROLE_META[m.role]?.label ?? m.role ?? 'Agent';
      return {
        type: 'agent' as const,
        title: label,
        position: pos,
        payload: {
          agent: m.agent,
          role: m.role,
          teamId: entry.id,
          agentId,
          cwd,
          latestHandoff: entry.latestHandoff
        }
      };
    });
    addCards(cards);
    const updatedEntry: TeamHistoryEntry = {
      ...entry,
      lastUsedAt: new Date().toISOString()
    };
    setRecent((prev) =>
      [updatedEntry, ...prev.filter((item) => item.id !== updatedEntry.id)].sort((a, b) =>
        b.lastUsedAt.localeCompare(a.lastUsedAt)
      )
    );
    void window.api.teamHistory.save(updatedEntry).catch((err) => {
      console.warn('[restore] team_history_save failed:', err);
    });
    setSpawnOpen(false);
  };

  const closeRecent = useMemo(
    () => recent.filter((r) => r.canvasState && r.canvasState.nodes.length > 0).slice(0, 6),
    [recent]
  );

  const cardCounter = (t: CardType): number => nodes.filter((n) => n.type === t).length + 1;

  // Issue #166: Date.now() % 600 だと連続クリックで数 ms 差しか出ず、全カードが
  // ほぼ同じ x に積み重なって UI 上「追加されていない」ように見えていた。
  // 既存ノード数 (現在 viewport 内に限らずグローバル) を 6 列グリッドに展開して
  // staggered レイアウトを返す。
  const stagger = (kind: CardType): { x: number; y: number } => {
    const idx = nodes.length; // 全 type 共通の連番でも視覚的に十分散る
    const cols = 6;
    const wrapTitle = ['agent', 'terminal'].includes(kind) ? 480 + 32 : 360 + 32;
    const wrapH = ['agent', 'terminal'].includes(kind) ? 320 + 32 : 240 + 32;
    return {
      x: (idx % cols) * wrapTitle,
      y: Math.floor(idx / cols) * wrapH
    };
  };

  const addAgent = (agent: 'claude' | 'codex'): void => {
    const cwd = projectRoot;
    const n = cardCounter('agent');
    addCards([
      {
        type: 'agent',
        title: agent === 'codex' ? `Codex #${n}` : `Claude #${n}`,
        position: stagger('agent'),
        payload: { agent, role: 'leader', cwd }
      }
    ]);
    setAddCardOpen(false);
  };

  const addByType = (type: Exclude<CardType, 'terminal' | 'agent'>): void => {
    const cwd = projectRoot;
    const titles: Record<typeof type, string> = {
      editor: t('canvas.card.editor'),
      diff: 'Diff',
      fileTree: t('sidebar.files'),
      changes: t('sidebar.changes')
    };
    const payload =
      type === 'fileTree' || type === 'changes'
        ? { projectRoot: cwd }
        : { projectRoot: cwd, relPath: '' };
    addCards([{ type, title: titles[type], position: stagger(type), payload }]);
    setAddCardOpen(false);
  };

  return (
    <div
      className="canvas-layout"
      // 非アクティブ時は表示・hit-test を完全に切る (内部 PTY は維持される)
      style={isCanvasActive ? undefined : { display: 'none' }}
      aria-hidden={!isCanvasActive}
    >
      <header className="canvas-header" data-tauri-drag-region>
        <span className="canvas-header__brand" data-tauri-drag-region>
          <MonitorSmartphone size={14} strokeWidth={1.75} data-tauri-drag-region />
          Canvas
        </span>
        <span className="canvas-header__count" data-tauri-drag-region>{formatCardCount(cardCount, settings.language)}</span>
        <div className="canvas-header__spacer" data-tauri-drag-region />

        <div className="canvas-popover__wrap" ref={addPopoverRef}>
          <button
            type="button"
            className="canvas-btn"
            onClick={() => setAddCardOpen((v) => !v)}
            aria-label={t('canvas.add.tooltip')}
            title={t('canvas.add.tooltip')}
          >
            <Plus size={13} strokeWidth={1.8} />
            {t('canvas.add')}
          </button>
          {addCardOpen && (
            <div className="canvas-popover">
              <AddItem
                icon={<AgentBadge label="C" color="#5c5cff" />}
                label={t('canvas.add.claude')}
                onClick={() => addAgent('claude')}
              />
              <AddItem
                icon={<AgentBadge label="X" color="#10b981" />}
                label={t('canvas.add.codex')}
                onClick={() => addAgent('codex')}
              />
              <div className="canvas-popover__section">{t('canvas.panels')}</div>
              <AddItem
                icon={<FolderTree size={13} />}
                label={t('canvas.add.fileTree')}
                onClick={() => addByType('fileTree')}
              />
              <AddItem
                icon={<GitBranch size={13} />}
                label={t('canvas.add.gitChanges')}
                onClick={() => addByType('changes')}
              />
              <AddItem
                icon={<FilePlus size={13} />}
                label={t('canvas.add.emptyEditor')}
                onClick={() => addByType('editor')}
              />
            </div>
          )}
        </div>

        <div className="canvas-popover__wrap" ref={spawnPopoverRef}>
          {/* Spawn Team は split button: メインクリックで dynamic-team を即起動、
              caret 部分でカスタム/最近使ったチームの popover を開く。 */}
          <div className="canvas-btn-split">
            <button
              type="button"
              className="canvas-btn canvas-btn--primary canvas-btn-split__main"
              onClick={() => void applyPreset(DEFAULT_SPAWN_PRESET)}
              aria-label={t('canvas.spawnTeam.tooltip')}
              title={t('canvas.spawnTeam.tooltip')}
            >
              <Sparkles size={13} strokeWidth={1.8} />
              {t('canvas.spawnTeam')}
            </button>
            <button
              type="button"
              className="canvas-btn canvas-btn--primary canvas-btn-split__caret"
              onClick={() => setSpawnOpen((v) => !v)}
              aria-label={t('canvas.spawnTeamMore.tooltip')}
              title={t('canvas.spawnTeamMore.tooltip')}
              aria-expanded={spawnOpen}
            >
              <ChevronDown size={12} strokeWidth={2} />
            </button>
          </div>
          {spawnOpen && (
            <div className="canvas-popover canvas-popover--wide">
              <div className="canvas-popover__tabs">
                <TabBtn active={tab === 'preset'} onClick={() => setTab('preset')}>
                  <Sparkles size={11} /> {t('canvas.preset')}
                </TabBtn>
                <TabBtn active={tab === 'recent'} onClick={() => setTab('recent')}>
                  <History size={11} /> {t('canvas.recent')}
                  {closeRecent.length > 0 && (
                    <span className="canvas-popover__tab-badge">{closeRecent.length}</span>
                  )}
                </TabBtn>
              </div>
              {tab === 'preset' && (
                <>
                  {BUILTIN_PRESETS.map((preset) => (
                    <BuiltinPresetItem
                      key={preset.id}
                      preset={preset}
                      label={t(preset.i18nKey)}
                      agentCountLabel={formatAgentCount(preset.members.length, settings.language)}
                      onClick={() => void applyPreset(preset)}
                    />
                  ))}
                </>
              )}
              {tab === 'recent' && (
                <>
                  {closeRecent.length === 0 && (
                    <div className="canvas-popover__empty">{t('canvas.noRecentTeams')}</div>
                  )}
                  {closeRecent.map((entry) => (
                    <RecentItem
                      key={entry.id}
                      entry={entry}
                      fallbackName={t('team.defaultName')}
                      agentCountLabel={formatAgentCount(entry.members.length, settings.language)}
                      lastUsedLabel={t('canvas.lastUsed', {
                        value: dateTimeFormatter.format(new Date(entry.lastUsedAt))
                      })}
                      onClick={() => void restoreRecent(entry)}
                    />
                  ))}
                </>
              )}
            </div>
          )}
        </div>

        {cardCount > 0 && (
          <button
            type="button"
            className="canvas-btn canvas-btn--ghost"
            onClick={() => {
              if (window.confirm(t('canvas.clearConfirm'))) clear();
            }}
            title={t('canvas.clear.tooltip')}
            aria-label={t('canvas.clear.tooltip')}
          >
            {t('canvas.clear')}
          </button>
        )}
        {availableUpdate && (
          <button
            type="button"
            className="canvas-btn canvas-btn--update"
            onClick={() => {
              void import('../lib/updater-check').then((m) =>
                m.runUpdateInstall({
                  language: settings.language,
                  showToast,
                  dismissToast,
                  manual: true
                })
              );
            }}
            title={t('updater.button.title', { version: availableUpdate.version })}
            aria-label={t('updater.button.title', { version: availableUpdate.version })}
          >
            <ArrowDownToLine size={13} strokeWidth={1.9} />
            {t('updater.button.label', { version: availableUpdate.version })}
          </button>
        )}
        <button
          type="button"
          className="canvas-btn"
          onClick={() => setViewMode('ide')}
          title={t('canvas.switchToIde.tooltip')}
          aria-label={t('canvas.switchToIde.tooltip')}
        >
          <Layout size={13} strokeWidth={1.8} />
          IDE
        </button>
        <WindowControls />
      </header>
      <div className="canvas-layout__body">
        <Rail
          sidebarView={sidebarView}
          onSidebarViewChange={setSidebarView}
          changeCount={railChangeCount}
          historyCount={railHistoryCount}
          onOpenSettings={() => setSettingsOpen(true)}
          hasGitRepo={railHasGitRepo}
        />
        {!sidebarCollapsed && (
          <CanvasSidebar
            view={sidebarView}
            onViewChange={setSidebarView}
            onChangeCount={setRailChangeCount}
            onHistoryCount={setRailHistoryCount}
            onGitOk={setRailHasGitRepo}
          />
        )}
        <div className="canvas-layout__stage">
          <Canvas />
        </div>
      </div>

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
    </div>
  );
}

function RoleDot({
  role,
  agent
}: {
  role: TeamRole;
  agent: TerminalAgent;
}): JSX.Element {
  // 動的ロール (Leader が team_create_role で作成した worker) は ROLE_META にエントリが
  // 無く undefined になり .label/.color/.glyph 参照で TypeError を起こす (#220 系で報告)。
  // roleMetaFor は不明 role に対して fallbackProfile を返してくれるので、これに切り替える。
  const meta = ROLE_META[role] ?? roleMetaFor(role, 'en');
  return (
    <span
      className="canvas-role-dot"
      title={`${meta.label} (${agent})`}
      style={{ ['--dot-color' as string]: meta.color } as React.CSSProperties}
    >
      {meta.glyph}
    </span>
  );
}

function BuiltinPresetItem({
  preset,
  label,
  agentCountLabel,
  onClick
}: {
  preset: WorkspacePreset;
  label: string;
  agentCountLabel: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button type="button" onClick={onClick} className="canvas-popover__preset">
      <span className="canvas-popover__preset-title-row">
        <span className="canvas-popover__preset-title">{label}</span>
        <span className="canvas-popover__preset-sub">{agentCountLabel}</span>
      </span>
      <span className="canvas-popover__preset-roles">
        {preset.members.map((m, i) => (
          <RoleDot key={i} role={m.role} agent={m.agent} />
        ))}
      </span>
    </button>
  );
}

function AgentBadge({ label, color }: { label: string; color: string }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="canvas-role-dot"
      style={
        {
          ['--dot-color' as string]: color,
          width: 18,
          height: 18,
          borderRadius: 4,
          fontSize: 10
        } as React.CSSProperties
      }
    >
      {label}
    </span>
  );
}

function TabBtn({
  active,
  onClick,
  children
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`canvas-popover__tab${active ? ' canvas-popover__tab--active' : ''}`}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}

function AddItem({
  icon,
  label,
  onClick
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button type="button" onClick={onClick} className="canvas-popover__item">
      {icon}
      {label}
    </button>
  );
}

function RecentItem({
  entry,
  fallbackName,
  agentCountLabel,
  lastUsedLabel,
  onClick
}: {
  entry: TeamHistoryEntry;
  fallbackName: string;
  agentCountLabel: string;
  lastUsedLabel: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button type="button" onClick={onClick} className="canvas-popover__preset">
      <span className="canvas-popover__preset-title-row">
        <span className="canvas-popover__preset-title">{entry.name || fallbackName}</span>
        <span className="canvas-popover__preset-sub">{agentCountLabel}</span>
      </span>
      <span className="canvas-popover__preset-sub">{lastUsedLabel}</span>
      <span className="canvas-popover__preset-roles">
        {entry.members.map((m, i) => (
          <RoleDot key={i} role={m.role} agent={m.agent} />
        ))}
      </span>
    </button>
  );
}

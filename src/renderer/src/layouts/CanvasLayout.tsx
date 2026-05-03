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
import { NODE_H, NODE_W } from '../stores/canvas';
import type {
  TeamHistoryEntry,
  TeamOrganizationMeta,
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
import { useHistoryBadgeCount } from '../lib/use-history-badge-count';
import { useCanvasStore } from '../stores/canvas';
import {
  BUILTIN_PRESETS,
  DEFAULT_SPAWN_PRESET,
  expandPresetOrganizations,
  presetMemberCount,
  presetOrganizationCount,
  presetPosition,
  type WorkspacePreset
} from '../lib/workspace-presets';
import { ROLE_META, roleMetaFor } from '../lib/team-roles';
import { useSettings } from '../lib/settings-context';
import { useToast } from '../lib/toast-context';
import {
  localeOf,
  formatCardCount,
  formatOrganizationAgentCount
} from '../lib/canvas-layout-helpers';
import { useCanvasTeamRestore } from '../lib/hooks/use-canvas-team-restore';
import { useCanvasAutoSave } from '../lib/hooks/use-canvas-auto-save';

type Tab = 'preset' | 'recent';

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
  // Issue #387: Rail の History バッジを「総件数」ではなく「未確認件数」へ。
  // CanvasSidebar が unmount される (= sidebarCollapsed) と件数通知が止まるため、
  // !sidebarCollapsed かつ sidebarView==='sessions' を確認済み条件にする。
  const railHistoryBadgeCount = useHistoryBadgeCount(
    railHistoryCount,
    sidebarView === 'sessions' && !sidebarCollapsed
  );
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

  // Phase 4-3: 起動時の Canvas チーム復元 (Issue #159) を hook 化
  useCanvasTeamRestore({
    projectRoot,
    nodes,
    mcpAutoSetup: settings.mcpAutoSetup !== false
  });

  // Phase 4-3: Canvas state を team-history へ自動保存する hook (Issue #167 / #132 / #124)
  useCanvasAutoSave({ projectRoot, nodes, viewport, recent, setRecent });

  const applyPreset = async (preset: WorkspacePreset): Promise<void> => {
    const cwd = projectRoot;
    const presetName = t(preset.i18nKey);
    const organizations = expandPresetOrganizations(preset, t, presetName);
    const plannedOrganizations = organizations.map((org) => {
      const teamId = `team-${crypto.randomUUID()}`;
      const organization: TeamOrganizationMeta = {
        id: teamId,
        ...org.meta
      };
      return { teamId, organization, members: org.members };
    });
    // Issue #72: setupTeamMcp を addCards より前に完了させる
    if (settings.mcpAutoSetup !== false) {
      for (const org of plannedOrganizations) {
        try {
          await window.api.app.setupTeamMcp(
            cwd,
            org.teamId,
            org.organization.name,
            org.members.map((m, i) => ({
              agentId: `${m.role}-${i}-${org.teamId}`,
              role: m.role,
              agent: m.agent
            }))
          );
        } catch (err) {
          console.warn('[preset] setupTeamMcp failed:', err);
        }
      }
    }
    const cards = plannedOrganizations.flatMap((org) =>
      org.members.map((m, i) => {
        const agentId = `${m.role}-${i}-${org.teamId}`;
        // Issue #69: 未知 role でもクラッシュしないよう fallback
        const label = ROLE_META[m.role]?.label ?? m.role ?? 'Agent';
        return {
          type: 'agent' as const,
          title: label,
          position: presetPosition(m.col, m.row),
          payload: {
            agent: m.agent,
            roleProfileId: m.role,
            role: m.role,
            teamId: org.teamId,
            agentId,
            cwd,
            organization: org.organization
          }
        };
      })
    );
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
      // Issue #385: 旧 team-history.json に NaN / Infinity / undefined な座標が残っていると、
      // 復元直後に React Flow が render 例外を出して Canvas 全体が黒画面になる。
      // 数値として有効でない場合は preset 配置にフォールバックする。
      const savedX = typeof saved?.x === 'number' && Number.isFinite(saved.x) ? saved.x : null;
      const savedY = typeof saved?.y === 'number' && Number.isFinite(saved.y) ? saved.y : null;
      const pos =
        savedX !== null && savedY !== null
          ? { x: savedX, y: savedY }
          : presetPosition(i % 3, Math.floor(i / 3));
      // Issue #69: 未知 role でも落ちないよう optional chain
      const label = ROLE_META[m.role]?.label ?? m.role ?? 'Agent';
      return {
        type: 'agent' as const,
        title: label,
        position: pos,
        payload: {
          agent: m.agent,
          roleProfileId: m.role,
          role: m.role,
          teamId: entry.id,
          agentId,
          resumeSessionId: m.sessionId ?? null,
          cwd,
          organization: entry.organization,
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
  // Issue #442: 旧実装は agent/terminal を 480+32 / 320+32、その他を 360+32 / 240+32 で
  // 並べていたが、addCard / addCards は全 type に NODE_W/NODE_H (= 640x400, Issue #253)
  // を style として付与するため、type 別ピッチは根拠が無くカードが重なっていた。
  // ピッチを実カードサイズ NODE_W/NODE_H に統一する。
  const stagger = (_kind: CardType): { x: number; y: number } => {
    const idx = nodes.length; // 全 type 共通の連番でも視覚的に十分散る
    const cols = 6;
    return {
      x: (idx % cols) * (NODE_W + 32),
      y: Math.floor(idx / cols) * (NODE_H + 32)
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
                      agentCountLabel={formatOrganizationAgentCount(
                        presetOrganizationCount(preset),
                        presetMemberCount(preset),
                        settings.language
                      )}
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
                      agentCountLabel={formatOrganizationAgentCount(
                        entry.organization ? 1 : 0,
                        entry.members.length,
                        settings.language
                      )}
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
          historyBadgeCount={railHistoryBadgeCount}
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
        {(preset.organizations ?? [{ id: 'primary', color: '', members: preset.members }]).map(
          (org, orgIndex) => (
            <span
              key={org.id}
              className="canvas-popover__preset-org"
              style={
                org.color
                  ? ({ ['--org-color' as string]: org.color } as React.CSSProperties)
                  : undefined
              }
            >
              {org.members.map((m, i) => (
                <RoleDot key={`${orgIndex}-${i}`} role={m.role} agent={m.agent} />
              ))}
            </span>
          )
        )}
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
      {entry.organization && (
        <span
          className="canvas-popover__org-badge"
          style={{ ['--org-color' as string]: entry.organization.color } as React.CSSProperties}
        >
          {entry.organization.name}
        </span>
      )}
      <span className="canvas-popover__preset-roles">
        {entry.members.map((m, i) => (
          <RoleDot key={i} role={m.role} agent={m.agent} />
        ))}
      </span>
    </button>
  );
}

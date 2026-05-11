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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Node } from '@xyflow/react';
import {
  ArrowDownToLine,
  ChevronDown,
  FilePlus,
  FolderTree,
  GitBranch,
  Layout,
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
import { Canvas, type CanvasActions } from '../components/canvas/Canvas';
import { CanvasSidebar } from '../components/canvas/CanvasSidebar';
import { Rail } from '../components/shell/Rail';
import { Topbar } from '../components/shell/Topbar';
import { AppMenuBar } from '../components/shell/AppMenuBar';
import type { SidebarView } from '../components/Sidebar';
import { SettingsModal } from '../components/SettingsModal';
import { useT } from '../lib/i18n';
import { useUiStore } from '../stores/ui';
import { useCanvasStore } from '../stores/canvas';
import { useCanvasViewport } from '../stores/canvas-selectors';
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
  formatOrganizationAgentCount
} from '../lib/canvas-layout-helpers';
import { useCanvasTeamRestore } from '../lib/hooks/use-canvas-team-restore';
import { useCanvasAutoSave } from '../lib/hooks/use-canvas-auto-save';
import { getDirtyEditorCardSnapshots } from '../lib/editor-card-dirty-registry';
import {
  spawnTeam,
  spawnTeams,
  type SpawnTeamMember,
  type SpawnTeamSpec
} from '../lib/canvas-team-spawn';

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
  const viewport = useCanvasViewport();
  const clear = useCanvasStore((s) => s.clear);
  const addCards = useCanvasStore((s) => s.addCards);
  const notifyRecruit = useCanvasStore((s) => s.notifyRecruit);
  const { settings, update: updateSettings, reset: resetSettings } = useSettings();
  const t = useT();
  // プロジェクトルート: runtime の lastOpenedRoot を優先。ユーザー設定の
  // claudeCwd (明示指定された作業ディレクトリ) は互換フォールバックとして扱う。
  const projectRoot = settings.lastOpenedRoot || settings.claudeCwd || '';
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const availableUpdate = useUiStore((s) => s.availableUpdate);
  const status = useUiStore((s) => s.status);
  const { showToast, dismissToast } = useToast();
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [tab, setTab] = useState<'preset' | 'recent'>('preset');
  const [addCardOpen, setAddCardOpen] = useState(false);
  const [recent, setRecent] = useState<TeamHistoryEntry[]>([]);
  const [sidebarView, setSidebarView] = useState<SidebarView>('files');
  const [railChangeCount, setRailChangeCount] = useState(0);
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
    // Issue #611: builtin / user / history の 3 経路で共通の spawnTeams helper を経由する。
    //   teamId 発行 / setupTeamMcp / agentId 採番 / 配置整理を helper に集約してドリフトを防ぐ。
    const teams: SpawnTeamSpec[] = organizations.map((org) => {
      const teamId = `team-${crypto.randomUUID()}`;
      const organization: TeamOrganizationMeta = { id: teamId, ...org.meta };
      const members: SpawnTeamMember[] = org.members.map((m) => ({
        role: m.role,
        agent: m.agent,
        position: presetPosition(m.col, m.row),
        // Issue #69: 未知 role でもクラッシュしないよう fallback
        title: ROLE_META[m.role]?.label ?? m.role ?? 'Agent'
      }));
      return { teamId, teamName: organization.name, organization, members };
    });
    const { cards } = await spawnTeams({
      cwd,
      teams,
      existingNodes: useCanvasStore.getState().nodes,
      mcpAutoSetup: settings.mcpAutoSetup !== false,
      setupTeamMcp: window.api.app.setupTeamMcp
    });
    const ids = addCards(cards);
    if (ids[0]) notifyRecruit(ids[0]);
    setSpawnOpen(false);
    void loadRecent();
  };

  const restoreRecent = async (entry: TeamHistoryEntry): Promise<void> => {
    const cwd = projectRoot || entry.projectRoot;
    // Issue #611 / #612: history-based 復元も spawnTeam 経由に統一。
    //   entry.latestHandoff / entry.organization の payload 同梱と placeBatchAwayFromNodes
    //   による衝突回避を applyPreset と同じ 1 関数で扱うことでドリフトを防ぐ。
    const members: SpawnTeamMember[] = entry.members.map((m, i) => {
      const fallbackAgentId = m.agentId ?? `${m.role}-${i}-${entry.id}`;
      const saved = entry.canvasState?.nodes.find((s) => s.agentId === fallbackAgentId);
      // Issue #385: 旧 team-history.json に NaN / Infinity / undefined な座標が残っていると、
      // 復元直後に React Flow が render 例外を出して Canvas 全体が黒画面になる。
      // 数値として有効でない場合は preset 配置にフォールバックする。
      const savedX = typeof saved?.x === 'number' && Number.isFinite(saved.x) ? saved.x : null;
      const savedY = typeof saved?.y === 'number' && Number.isFinite(saved.y) ? saved.y : null;
      const position =
        savedX !== null && savedY !== null
          ? { x: savedX, y: savedY }
          : presetPosition(i % 3, Math.floor(i / 3));
      return {
        role: m.role,
        agent: m.agent,
        position,
        // Issue #69: 未知 role でも落ちないよう optional chain
        title: ROLE_META[m.role]?.label ?? m.role ?? 'Agent',
        resumeSessionId: m.sessionId ?? null,
        // legacy team-history が保持していた特殊 agentId を尊重 (helper 側に明示渡し)
        agentId: m.agentId ?? undefined
      };
    });
    const { cards } = await spawnTeam({
      teamId: entry.id,
      teamName: entry.name,
      cwd,
      members,
      organization: entry.organization,
      latestHandoff: entry.latestHandoff,
      existingNodes: useCanvasStore.getState().nodes,
      mcpAutoSetup: settings.mcpAutoSetup !== false,
      setupTeamMcp: window.api.app.setupTeamMcp
    });
    const ids = addCards(cards);
    if (ids[0]) notifyRecruit(ids[0]);
    const updatedEntry: TeamHistoryEntry = {
      ...entry,
      lastUsedAt: new Date().toISOString()
    };
    setRecent((prev) =>
      [updatedEntry, ...prev.filter((item) => item.id !== updatedEntry.id)].sort((a, b) =>
        b.lastUsedAt.localeCompare(a.lastUsedAt)
      )
    );
    // Issue #642: save が外部変更を検知して merge した場合は team-history list を再取得して
    // setRecent を最新 disk 状態に同期する (= setRecent で push した updatedEntry は保持しつつ、
    // 他 entry の手編集を UI 上にも反映)。renderer の他の auto-save 経路 (saveBatch 等) を
    // 持つ caller も同様に `externalChangeMerged === true` を観測したら list 再取得すべき。
    void window.api.teamHistory
      .save(updatedEntry)
      .then((res) => {
        if (res?.externalChangeMerged === true) {
          console.info(
            '[team-history] external change merged on save; refreshing recent list'
          );
          window.api.teamHistory
            .list(projectRoot)
            .then(setRecent)
            .catch((err) => {
              console.warn('[team-history] refresh after external merge failed:', err);
            });
        }
      })
      .catch((err) => {
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

  const handleRestart = async (): Promise<void> => {
    const dirty = getDirtyEditorCardSnapshots();
    if (dirty.length > 0) {
      const paths = dirty.map((d) => `• ${d.relPath}`).join('\n');
      const message = t('canvas.clearConfirmWithDirtyEditors', {
        count: dirty.length,
        paths
      });
      if (!window.confirm(message)) return;
    }
    await window.api.app.restart();
  };

  const handleClickUpdate = (): void => {
    void import('../lib/updater-check').then((m) =>
      m.runUpdateInstall({
        language: settings.language,
        showToast,
        dismissToast,
        manual: true
      })
    );
  };

  // ---- AppMenuBar 用ハンドラ群。IDE / Canvas で同一メニューを出すため Canvas 側も実装する。
  //      workspace 系は settings.update で完結 (recentProjects / workspaceFolders / lastOpenedRoot)。
  //      handleOpenFile だけ Canvas 固有: Editor カードを addCard で配置する。
  const pushRecent = useCallback(
    async (path: string): Promise<void> => {
      const next = [path, ...(settings.recentProjects ?? []).filter((p) => p !== path)].slice(0, 12);
      await updateSettings({ recentProjects: next, lastOpenedRoot: path });
    },
    [settings.recentProjects, updateSettings]
  );

  const handleNewProject = useCallback(async () => {
    const picked = await window.api.dialog.openFolder(t('appMenu.newDialogTitle'));
    if (picked) await pushRecent(picked);
  }, [pushRecent, t]);

  const handleOpenFolder = useCallback(async () => {
    const picked = await window.api.dialog.openFolder(t('appMenu.openFolderDialogTitle'));
    if (picked) await pushRecent(picked);
  }, [pushRecent, t]);

  const handleOpenFile = useCallback(async () => {
    const picked = await window.api.dialog.openFile(t('appMenu.openFileDialogTitle'));
    if (!picked) return;
    const dir = picked.replace(/[\\/][^\\/]+$/, '');
    const name = picked.slice(dir.length + 1);
    useCanvasStore.getState().addCard({
      type: 'editor',
      title: name,
      payload: { projectRoot: dir, relPath: name }
    });
  }, [t]);

  const handleAddWorkspaceFolder = useCallback(async () => {
    const picked = await window.api.dialog.openFolder(t('appMenu.addWorkspaceDialogTitle'));
    if (!picked) return;
    const current = settings.workspaceFolders ?? [];
    if (current.includes(picked)) return;
    await updateSettings({ workspaceFolders: [...current, picked] });
  }, [settings.workspaceFolders, updateSettings, t]);

  const handleOpenRecent = useCallback(
    (path: string): void => {
      void pushRecent(path);
    },
    [pushRecent]
  );

  const handleCheckUpdate = useCallback((): void => {
    void import('../lib/updater-check').then((m) =>
      m.checkForUpdates({
        language: settings.language,
        showToast,
        dismissToast,
        manual: true,
        // Canvas モードでは IDE の terminalTabs を持たない (タブは Canvas カード側で管理)。
        // updater 側は "0" でも問題なく動く (running task 警告が出ないだけ)。
        runningTaskCount: 0
      })
    );
  }, [settings.language, showToast, dismissToast]);

  const handleOpenGithub = useCallback((): void => {
    void window.api.app.openExternal('https://github.com/yusei531642/vibe-editor');
  }, []);

  const clearCanvas = (): void => {
    const dirty = getDirtyEditorCardSnapshots();
    if (dirty.length === 0) {
      if (window.confirm(t('canvas.clearConfirm'))) clear();
      return;
    }
    const paths = dirty.map((d) => `• ${d.relPath}`).join('\n');
    const message = t('canvas.clearConfirmWithDirtyEditors', {
      count: dirty.length,
      paths
    });
    if (window.confirm(message)) clear();
  };

  const canvasActions = useMemo<CanvasActions>(
    () => ({
      addClaude: () => addAgent('claude'),
      addCodex: () => addAgent('codex'),
      addFileTree: () => addByType('fileTree'),
      addChanges: () => addByType('changes'),
      addEditor: () => addByType('editor'),
      spawnDefaultTeam: () => void applyPreset(DEFAULT_SPAWN_PRESET)
    }),
    // addAgent / addByType / applyPreset are recreated with the current project/settings values.
    // Keeping this object memoized prevents Canvas context-menu handlers from rebinding on
    // unrelated CanvasLayout state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectRoot, nodes.length, settings.language, settings.mcpAutoSetup, addCards, notifyRecruit]
  );

  return (
    <div
      className="canvas-layout"
      // 非アクティブ時は表示・hit-test を完全に切る (内部 PTY は維持される)
      style={isCanvasActive ? undefined : { display: 'none' }}
      aria-hidden={!isCanvasActive}
    >
      <Topbar
        projectRoot={projectRoot}
        status={status}
        onRestart={handleRestart}
        onOpenPalette={() => setPaletteOpen(true)}
        availableUpdate={availableUpdate}
        onClickUpdate={handleClickUpdate}
        menuBar={
          <AppMenuBar
            recentProjects={settings.recentProjects ?? []}
            onNewProject={() => void handleNewProject()}
            onOpenFolder={() => void handleOpenFolder()}
            onOpenFile={() => void handleOpenFile()}
            onAddWorkspaceFolder={() => void handleAddWorkspaceFolder()}
            onOpenRecent={handleOpenRecent}
            onRestart={() => void handleRestart()}
            onCheckUpdate={handleCheckUpdate}
            onOpenGithub={handleOpenGithub}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenPalette={() => setPaletteOpen(true)}
            onToggleSidebar={() => toggleSidebar()}
            onToggleCanvas={() => setViewMode(viewMode === 'canvas' ? 'ide' : 'canvas')}
          />
        }
        extraActions={
          <>
            {cardCount > 0 && (
              <button
                type="button"
                className="canvas-btn canvas-btn--ghost"
                onClick={clearCanvas}
                title={t('canvas.clear.tooltip')}
                aria-label={t('canvas.clear.tooltip')}
              >
                {t('canvas.clear')}
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
          </>
        }
      />
      <div className="canvas-layout__body">
        <Rail
          sidebarView={sidebarView}
          onSidebarViewChange={setSidebarView}
          changeCount={railChangeCount}
          onOpenSettings={() => setSettingsOpen(true)}
          hasGitRepo={railHasGitRepo}
        />
        {!sidebarCollapsed && (
          <CanvasSidebar
            view={sidebarView}
            onViewChange={setSidebarView}
            onChangeCount={setRailChangeCount}
            onGitOk={setRailHasGitRepo}
          />
        )}
        <div className="canvas-layout__stage">
          <Canvas actions={canvasActions} />
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
  const orchestration = entry.orchestration;
  const stateLabel = orchestration?.blockedByHumanGate
    ? `blocked_by_human_gate: ${
        orchestration.requiredHumanDecision ?? orchestration.blockedReason ?? ''
      }`
    : orchestration?.latestHandoffStatus
      ? `handoff: ${orchestration.latestHandoffStatus}`
      : '';
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
      {stateLabel && (
        <span
          className={`canvas-popover__preset-state ${
            orchestration?.blockedByHumanGate ? 'is-blocked' : ''
          }`}
        >
          {stateLabel}
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

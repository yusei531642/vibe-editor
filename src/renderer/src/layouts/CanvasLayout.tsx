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
 *
 * Issue #1032 (god-file 分割): チーム起動は use-canvas-spawn / CanvasSpawnFab、
 * 単体カード追加は use-canvas-add-card、AppMenuBar 操作は use-canvas-menu-actions が
 * それぞれ所有する。ここはシェル (Topbar / Rail / Sidebar / Canvas) の組み立てに徹する。
 */
import { useEffect, useMemo, useState } from 'react';
import type { Node } from '@xyflow/react';
import { Layout } from 'lucide-react';
import type { CardData } from '../stores/canvas';
import { Canvas, type CanvasActions } from '../components/canvas/Canvas';
import { CanvasSidebar } from '../components/canvas/CanvasSidebar';
import { CanvasSpawnFab } from '../components/canvas/CanvasSpawnFab';
import { VoiceControlButton } from '../components/canvas/VoiceControlButton';
import { Rail } from '../components/shell/Rail';
import { Topbar } from '../components/shell/Topbar';
import { AppMenuBar } from '../components/shell/AppMenuBar';
import type { SidebarView } from '../components/Sidebar';
import { SettingsModal } from '../components/SettingsModal';
import { useT } from '../lib/i18n';
import { useUiStore } from '../stores/ui';
import { useCanvasStore } from '../stores/canvas';
import { useCanvasViewport } from '../stores/canvas-selectors';
import { DEFAULT_SPAWN_PRESET } from '../lib/workspace-presets';
import { useSettings } from '../lib/settings-context';
import { useCanvasTeamRestore } from '../lib/hooks/use-canvas-team-restore';
import { useCanvasAutoSave } from '../lib/hooks/use-canvas-auto-save';
import { useCanvasAddCard } from '../lib/hooks/use-canvas-add-card';
import { useCanvasMenuActions } from '../lib/hooks/use-canvas-menu-actions';
import { useCanvasSpawn } from '../lib/hooks/use-canvas-spawn';
import { useLayoutResize } from '../lib/hooks/use-layout-resize';

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
  const [sidebarView, setSidebarView] = useState<SidebarView>('files');
  const [railChangeCount, setRailChangeCount] = useState(0);
  const [railHasGitRepo, setRailHasGitRepo] = useState(true);
  // git リポジトリが無いと判明 + 現在 'changes' を見ている → 'files' に退避
  useEffect(() => {
    if (!railHasGitRepo && sidebarView === 'changes') {
      setSidebarView('files');
    }
  }, [railHasGitRepo, sidebarView]);

  // Issue #1032: 単体カード追加 / チーム起動 / メニュー操作は各 hook が所有する。
  const { stagger, addAgent, addCustomAgent, addApiAgent, addByType } = useCanvasAddCard({
    nodes,
    projectRoot
  });
  const {
    recent,
    setRecent,
    closeRecent,
    applyPreset,
    applySavedPreset,
    applyCustomAgentLeaderPreset,
    restoreRecent,
    spawnTeamPresetById
  } = useCanvasSpawn({ projectRoot, stagger });
  const menu = useCanvasMenuActions();

  // Phase 4-3: 起動時の Canvas チーム復元 (Issue #159) を hook 化
  useCanvasTeamRestore({
    projectRoot,
    nodes,
    mcpAutoSetup: settings.mcpAutoSetup !== false
  });

  // Phase 4-3: Canvas state を team-history へ自動保存する hook (Issue #167 / #132 / #124)
  useCanvasAutoSave({ projectRoot, nodes, viewport, recent, setRecent });

  // Canvas でも IDE 側と同じ sidebar 幅ハンドラを使う。
  // `--shell-sidebar-w` を共有しているので、ハンドルだけ Canvas にも生やせばリサイズが効く。
  const { onSidebarResizeStart, onSidebarResizeDouble } = useLayoutResize();

  const canvasActions = useMemo<CanvasActions>(
    () => ({
      addClaude: () => addAgent('claude'),
      addCodex: () => addAgent('codex'),
      addApiAgent,
      addCustomAgent,
      addFileTree: () => addByType('fileTree'),
      addChanges: () => addByType('changes'),
      addEditor: () => addByType('editor'),
      spawnDefaultTeam: () => void applyPreset(DEFAULT_SPAWN_PRESET)
    }),
    // addAgent / addByType / applyPreset are recreated with the current project/settings values.
    // Keeping this object memoized prevents Canvas context-menu handlers from rebinding on
    // unrelated CanvasLayout state changes. customAgents を deps に含め、追加導線が最新の
    // 登録エージェントを参照するようにする (Issue #1117)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      projectRoot,
      nodes.length,
      settings.language,
      settings.mcpAutoSetup,
      settings.customAgents
    ]
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
        availableUpdate={availableUpdate}
        onClickUpdate={menu.handleClickUpdate}
        menuBar={
          <AppMenuBar
            recentProjects={settings.recentProjects ?? []}
            onNewProject={() => void menu.handleNewProject()}
            onOpenFolder={() => void menu.handleOpenFolder()}
            onOpenFile={() => void menu.handleOpenFile()}
            onAddWorkspaceFolder={() => void menu.handleAddWorkspaceFolder()}
            onOpenRecent={menu.handleOpenRecent}
            onRestart={() => void menu.handleRestart()}
            onCheckUpdate={menu.handleCheckUpdate}
            onOpenGithub={menu.handleOpenGithub}
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
                onClick={() => void menu.clearCanvas()}
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
        {!sidebarCollapsed && (
          <div
            className="resize-handle resize-handle--sidebar"
            onMouseDown={onSidebarResizeStart}
            onDoubleClick={onSidebarResizeDouble}
            title={t('layout.sidebarResizeTitle')}
            role="separator"
            aria-orientation="vertical"
          />
        )}
        <div className="canvas-layout__stage">
          <Canvas actions={canvasActions} />
          {/* Issue #825: 音声指揮モード (Beta) のトグルボタン。
              内部で voice.enabled / hasApiKey の 2 条件を確認し、満たさない場合は null を返す。
              Settings で enable した直後にも反映できるよう常時マウントしておく。
              spawn_team_preset の実体は use-canvas-spawn の applyPreset を id 経由で呼ぶ薄ラッパ。 */}
          <VoiceControlButton onSpawnTeamPreset={spawnTeamPresetById} />
          <CanvasSpawnFab
            closeRecent={closeRecent}
            applyPreset={applyPreset}
            applySavedPreset={applySavedPreset}
            applyCustomAgentLeaderPreset={applyCustomAgentLeaderPreset}
            restoreRecent={restoreRecent}
          />
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

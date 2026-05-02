/**
 * Canvas — vibe-editor の無限キャンバスモード本体。
 *
 * Phase 3: AgentNodeCard + HandoffEdge + Workspace Preset 対応。
 * Rust 側 TeamHub から `team:handoff` event が来たら、from→to エッジを
 * 一時的に追加して 10 秒で自動 fade (#379)。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
// Controls (zoom/+/-、fit、lock 4 ボタン) はデフォルトで白くアプリのテーマと合わないため import しない。
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  MiniMap,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  useReactFlow,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useTeamHandoff } from '../../lib/use-team-handoff';
import TerminalCard from './cards/TerminalCard';
import AgentNodeCard from './cards/AgentNodeCard';
import EditorCard from './cards/EditorCard';
import DiffCard from './cards/DiffCard';
import FileTreeCard from './cards/FileTreeCard';
import ChangesCard from './cards/ChangesCard';
import HandoffEdge from './HandoffEdge';
import { QuickNav } from './QuickNav';
import { LeaderGlow } from './LeaderGlow';
import { StageHud } from './StageHud';
import { useCanvasStore, NODE_W, NODE_H, type CardData } from '../../stores/canvas';
import { colorOf } from '../../lib/team-roles';
import { KEYS, useKeybinding } from '../../lib/keybindings';
import { useUiStore } from '../../stores/ui';
import { ContextMenu, type ContextMenuItem } from '../ContextMenu';
import { useT } from '../../lib/i18n';
import { useConfirmRemoveCard } from '../../lib/use-confirm-remove-card';

const nodeTypes = {
  terminal: TerminalCard,
  agent: AgentNodeCard,
  editor: EditorCard,
  diff: DiffCard,
  fileTree: FileTreeCard,
  changes: ChangesCard
};

const edgeTypes = {
  handoff: HandoffEdge
};

function FlowApp(): JSX.Element {
  const t = useT();
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const setNodes = useCanvasStore((s) => s.setNodes);
  const setEdges = useCanvasStore((s) => s.setEdges);
  const setViewport = useCanvasStore((s) => s.setViewport);
  const addCard = useCanvasStore((s) => s.addCard);
  // ユーザー操作 (× / 右クリック / Delete) からの削除はチーム全員カスケード前に確認を挟む。
  const confirmRemoveCard = useConfirmRemoveCard();
  const pulseEdge = useCanvasStore((s) => s.pulseEdge);
  const setTeamLock = useCanvasStore((s) => s.setTeamLock);
  // 個別の getter は store から都度引く (selector は使わない: teamLocks 全体購読すると
  // ロック切替で全カード再レンダーになるため、必要時に getState で参照する)。
  const isTeamLocked = useCallback((teamId: string): boolean => {
    return useCanvasStore.getState().isTeamLocked(teamId);
  }, []);

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<CardData>>[]) => {
      // remove はチームカスケードのため store.removeCard 経由で処理する。
      // (Delete キー / React Flow 内部削除でもチーム全員が一括で閉じるように)
      const removes = changes.filter((c) => c.type === 'remove');
      for (const r of removes) {
        confirmRemoveCard(r.id);
      }
      const remaining = removes.length > 0
        ? changes.filter((c) => c.type !== 'remove')
        : changes;
      if (remaining.length === 0) return;

      // Issue #196: 旧実装は変更ごとに `nodes.find` + `for (other of nodes)` + 内側 `remaining.some(...)`
      // で O(N×M) になっており、6 人チーム × 4 種カード = 24 ノード規模で 1 px ドラッグごとに
      // 数百ステップ走り 16ms フレーム予算を超えやすかった。
      //
      // 修正: 1 フレームに 1 度だけインデックスを構築し、内部ループを O(チームサイズ) + O(1) に落とす。
      //   - nodesById: id → Node のマップ (旧 nodes.find = O(N))
      //   - teamMembers: teamId → Node[] のマップ (旧 nodes 全走査をチーム単位に絞る)
      //   - pendingPosIds / pendingDimIds: remaining 内に既存の position/dimensions 変更がある id の Set
      //     (旧 remaining.some 二重ループを Set.has の O(1) に置換)
      //   - lockedTeams: teamId → boolean のキャッシュ (isTeamLocked の重複呼び出しを削減)
      // payload は CardData 内で複数のサブ型を持つため { teamId?: string } で局所キャストする。
      // 同じキャストが index 構築 + position/dimensions 分岐で計 3 回走るので helper に集約。
      const teamIdOf = (n: Node<CardData>): string | undefined =>
        (n.data?.payload as { teamId?: string } | undefined)?.teamId;
      const nodesById = new Map<string, Node<CardData>>();
      const teamMembers = new Map<string, Node<CardData>[]>();
      for (const n of nodes) {
        nodesById.set(n.id, n);
        const tid = teamIdOf(n);
        if (tid) {
          let bucket = teamMembers.get(tid);
          if (!bucket) {
            bucket = [];
            teamMembers.set(tid, bucket);
          }
          bucket.push(n);
        }
      }
      const pendingPosIds = new Set<string>();
      const pendingDimIds = new Set<string>();
      for (const c of remaining) {
        if (c.type === 'position' && 'id' in c) pendingPosIds.add(c.id);
        else if (c.type === 'dimensions' && 'id' in c) pendingDimIds.add(c.id);
      }
      const lockedTeams = new Map<string, boolean>();
      const isLocked = (tid: string): boolean => {
        const cached = lockedTeams.get(tid);
        if (cached !== undefined) return cached;
        const v = isTeamLocked(tid);
        lockedTeams.set(tid, v);
        return v;
      };

      // ----- チーム同期ドラッグ + 同期リサイズ -----
      const extra: NodeChange<Node<CardData>>[] = [];
      for (const c of remaining) {
        // 位置同期 (ドラッグ): delta を全員に伝える
        if (c.type === 'position' && c.position) {
          const node = nodesById.get(c.id);
          if (!node) continue;
          const teamId = teamIdOf(node);
          if (!teamId || !isLocked(teamId)) continue;
          const dx = c.position.x - node.position.x;
          const dy = c.position.y - node.position.y;
          if (dx === 0 && dy === 0) continue;
          const members = teamMembers.get(teamId);
          if (!members) continue;
          for (const other of members) {
            if (other.id === node.id) continue;
            if (pendingPosIds.has(other.id)) continue;
            extra.push({
              id: other.id,
              type: 'position',
              position: { x: other.position.x + dx, y: other.position.y + dy },
              dragging: c.dragging
            });
          }
          continue;
        }
        // サイズ同期 (NodeResizer): リサイズ後のサイズに全員揃える
        if (c.type === 'dimensions' && c.dimensions && c.resizing) {
          const node = nodesById.get(c.id);
          if (!node) continue;
          const teamId = teamIdOf(node);
          if (!teamId || !isLocked(teamId)) continue;
          const w = c.dimensions.width;
          const h = c.dimensions.height;
          const members = teamMembers.get(teamId);
          if (!members) continue;
          for (const other of members) {
            if (other.id === node.id) continue;
            if (pendingDimIds.has(other.id)) continue;
            extra.push({
              id: other.id,
              type: 'dimensions',
              dimensions: { width: w, height: h },
              resizing: c.resizing,
              setAttributes: true
            });
          }
          continue;
        }
      }

      const allChanges = extra.length > 0 ? [...remaining, ...extra] : remaining;
      setNodes(applyNodeChanges(allChanges, nodes));
    },
    [nodes, setNodes, confirmRemoveCard, isTeamLocked]
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => setEdges(applyEdgeChanges(changes, edges)),
    [edges, setEdges]
  );
  const onConnect = useCallback(
    (c: Connection) => setEdges(addEdge(c, edges)),
    [edges, setEdges]
  );

  // ----- 右クリックメニュー (カード単位) -----
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    items: ContextMenuItem[];
  } | null>(null);

  // Ctrl+Space / Pane 右クリック共通: 新規 AI Agent (Claude Code) を追加
  const handleAddClaudeAgent = useCallback((): void => {
    const n = nodes.filter((x) => x.type === 'agent').length + 1;
    addCard({
      type: 'agent',
      title: `Claude #${n}`,
      payload: { agent: 'claude', role: 'leader' }
    });
  }, [addCard, nodes]);

  const handleNodeContextMenu = useCallback(
    (e: React.MouseEvent, node: Node<CardData>) => {
      e.preventDefault();
      e.stopPropagation();
      const teamId = (node.data?.payload as { teamId?: string } | undefined)?.teamId;
      const items: ContextMenuItem[] = [];
      if (teamId) {
        const locked = isTeamLocked(teamId);
        items.push({
          label: locked ? t('canvasMenu.unlockTeam') : t('canvasMenu.lockTeam'),
          action: () => setTeamLock(teamId, !locked),
          divider: true
        });
      }
      items.push({
        label: t('canvasMenu.deleteCard'),
        action: () => confirmRemoveCard(node.id)
      });
      setContextMenu({ x: e.clientX, y: e.clientY, items });
    },
    [isTeamLocked, confirmRemoveCard, setTeamLock, t]
  );

  // 空のキャンバス (Pane) で右クリックされたとき: 「ここに Claude を追加」を出す。
  // ユーザーが「右クリックしてもメニューが出ない」と感じる主因は、ノード上ではなく
  // Pane 上を狙ってしまっているケース。Pane 用にも明示的にハンドラを生やしておく。
  const handlePaneContextMenu = useCallback(
    (e: React.MouseEvent | MouseEvent) => {
      e.preventDefault();
      const items: ContextMenuItem[] = [
        {
          label: t('canvasMenu.addClaudeHere'),
          action: () => handleAddClaudeAgent()
        }
      ];
      setContextMenu({ x: e.clientX, y: e.clientY, items });
    },
    [t, handleAddClaudeAgent]
  );

  // Issue #158: hand-off event は use-team-handoff の集約 listener 経由で受け取る。
  // Tauri listen は ActivityFeed と共有なので二重登録にならない。
  useTeamHandoff((p) => {
    const currentNodes = useCanvasStore.getState().nodes;
    const fromNode = currentNodes.find(
      (n) => n.data?.cardType === 'agent' && (n.data.payload as { agentId?: string } | undefined)?.agentId === p.fromAgentId
    );
    const toNode = currentNodes.find(
      (n) => n.data?.cardType === 'agent' && (n.data.payload as { agentId?: string } | undefined)?.agentId === p.toAgentId
    );
    if (!fromNode || !toNode) return;
    pulseEdge({
      id: `handoff-${p.messageId}-${Date.now()}`,
      source: fromNode.id,
      target: toNode.id,
      type: 'handoff',
      data: { color: colorOf(p.fromRole), preview: p.preview, fromRole: p.fromRole }
    });
  });

  const minimapColor = useCallback((node: Node) => {
    const data = node.data as CardData | undefined;
    if (data?.cardType === 'agent') {
      const role = (data.payload as { role?: string } | undefined)?.role;
      return colorOf(role);
    }
    return '#7a7afd';
  }, []);

  const initialViewport = useMemo(() => useCanvasStore.getState().viewport, []);

  // ---- Phase 4: keybindings ----
  const setViewMode = useUiStore((s) => s.setViewMode);
  const [quickNavOpen, setQuickNavOpen] = useState(false);
  useKeybinding(KEYS.quickNav, () => setQuickNavOpen(true));
  useKeybinding(KEYS.toggleIde, () => setViewMode('ide'));
  useKeybinding(KEYS.newTerminal, handleAddClaudeAgent);

  const stageView = useCanvasStore((s) => s.stageView);

  // Issue #253 review (#2 + #7): recruit 後に fitView({ padding, duration }) を発火させて、
  // RECRUIT_RADIUS=NODE_W+80 で 6 名同心円配置時に端メンバーが viewport から外れる
  // UX 退行を吸収する。lastRecruitAt は use-recruit-listener が card 追加直後に
  // notifyRecruit() で書き、本 effect が変化を検知する。
  // 200ms debounce: team_recruit が短時間に複数名 (Leader+5 等) を追加するケースで、
  // fitView アニメーションが連続発火してカクつく問題を回避。最後の更新から 200ms 経過後に
  // 1 回だけ fitView を呼ぶ。debounce 時間は新ノードのレンダー完了 (~16ms) より十分長く、
  // ユーザーの体感遅延 (300ms 程度の許容) より短い実用値。
  // Issue #259: fitView 後に zoom が極端に下がるとターミナル文字が判読困難になる UX 退行を防ぐ。
  // 結果 zoom が MIN_RECRUIT_ZOOM を下回った場合は Leader (= recruit 直近の中心ノード) で
  // setCenter のみ実行し zoom を確保する。一部メンバーは viewport 外になるが、ユーザーは pan で閲覧可能。
  const MIN_RECRUIT_ZOOM = 0.7;
  const lastRecruitAt = useCanvasStore((s) => s.lastRecruitAt);
  const reactFlow = useReactFlow();
  useEffect(() => {
    if (!lastRecruitAt) return;
    const timer = window.setTimeout(() => {
      try {
        // minZoom オプションで fitView 自体が極端に縮小しないようガード (@xyflow/react v12)
        reactFlow.fitView({ padding: 0.15, duration: 300, minZoom: MIN_RECRUIT_ZOOM });
        // 防衛的フォールバック: minZoom が反映されない paths があった場合に備えて、
        // 結果 zoom を確認し閾値未満なら Leader を中心に setCenter で zoom を強制する。
        const vp = reactFlow.getViewport();
        if (vp.zoom < MIN_RECRUIT_ZOOM) {
          const leader = reactFlow.getNodes()[0];
          if (leader) {
            reactFlow.setCenter(
              leader.position.x + NODE_W / 2,
              leader.position.y + NODE_H / 2,
              { zoom: MIN_RECRUIT_ZOOM, duration: 300 }
            );
          }
        }
      } catch {
        /* viewport 計算に失敗するレアケースは無視 */
      }
    }, 200);
    return () => window.clearTimeout(timer);
  }, [lastRecruitAt, reactFlow]);

  return (
    <div
      className="tc-stage-root"
      data-view={stageView}
      style={{ position: 'absolute', inset: 0 }}
    >
      <LeaderGlow />
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onMoveEnd={(_, vp) => setViewport(vp)}
        onNodeContextMenu={handleNodeContextMenu}
        onPaneContextMenu={handlePaneContextMenu}
        // Delete キーで選択中カードを削除 (Backspace は xterm 入力と衝突するので除外)
        deleteKeyCode={['Delete']}
        defaultViewport={initialViewport}
        // --- zoom / pan の挙動 ---
        // Figma/Miro 風のカメラ zoom を React Flow 本来の挙動として復活。
        //   - wheel (ホイール) = カーソル位置中心にズーム (cards は相対的に動く)
        //   - pinch = ズーム
        //   - ドラッグ (左・中・右) = パン
        // transform: scale() の副作用で zoom > 1 のときテキストが若干滲む。
        // これは React Flow の DOM ベース描画では不可避だが、maxZoom を 1.5 に抑え、
        // font-smoothing / text-rendering の CSS ヒント (canvas.css) で最小化済み。
        minZoom={0.3}
        maxZoom={1.5}
        // Issue #253: fitView は初回マウント直後に viewport を再計算するため、
        // TerminalCard の初回 spawn (useFitToContainer / usePtySession) が同時に走ると
        // container.clientWidth がまだ確定していない瞬間を読んで cols/rows が崩れる
        // レースが起きる。defaultViewport (persist された前回 viewport / 新規は 0,0,zoom=1)
        // で初期表示し、全体俯瞰したいときはキー操作 (KEYS.fitView) で明示発動する方針に変更。
        fitView={false}
        zoomOnScroll
        zoomOnPinch
        zoomOnDoubleClick={false}
        panOnDrag={[0, 1, 2]}
        // onlyRenderVisibleElements は付けない。
        // 付けると React Flow がビューポート外のカードを DOM からアンマウントし、
        // TerminalCard 配下の usePtySession クリーンアップが走って PTY (= Claude/Codex)
        // ごと kill されてしまう。
        // パンで視点を動かしただけで Claude が死ぬのは UX として許容できないので、
        // 多少の DOM 増加は呑んで全カードを常時マウントしておく。
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={32} color="var(--canvas-grid, #1c1c20)" />
        {/* React Flow デフォルトの白い縦 4 ボタン (zoom/+/-、fit、lock) は UI と不整合なので非表示。
            ズームはマウスホイール / トラックパッド、fit はキー (KEYS.fitView)、lock は不要なため。 */}
        <MiniMap
          pannable
          zoomable
          nodeColor={minimapColor}
          maskColor="rgba(0,0,0,0.6)"
          style={{ background: '#0d0d12' }}
        />
      </ReactFlow>

      {stageView === 'list' ? <StageListOverlay /> : null}
      <StageHud />
      <QuickNav open={quickNavOpen} onClose={() => setQuickNavOpen(false)} />
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

/** stageView === 'list' のときに ReactFlow の代わりに表示する簡易ロスター。
 *  Canvas 上の agent ノードを一覧化する。 */
function StageListOverlay(): JSX.Element {
  const nodes = useCanvasStore((s) => s.nodes);
  const agentNodes = nodes.filter((n) => (n.data as CardData | undefined)?.cardType === 'agent');
  return (
    <div className="tc-list-overlay">
      <div className="tc-list-overlay__inner">
        <div className="tc-list-overlay__head">
          <h2 className="tc-list-overlay__title">チーム</h2>
          <span className="tc-list-overlay__sub">{agentNodes.length} agents</span>
        </div>
        {agentNodes.length === 0 ? (
          <div className="tc-list-overlay__empty">まだエージェントが配置されていません</div>
        ) : (
          agentNodes.map((n) => {
            const payload = (n.data as CardData | undefined)?.payload as
              | { role?: string; agentId?: string; agent?: string }
              | undefined;
            const color = colorOf(payload?.role);
            return (
              <div key={n.id} className="tc-list-row" style={{ ['--role-color' as string]: color }}>
                <span className="tc-list-row__avatar">
                  {(payload?.role ?? '?').charAt(0).toUpperCase()}
                </span>
                <div className="tc-list-row__id">
                  <span className="tc-list-row__name">{(n.data as CardData | undefined)?.title}</span>
                  <span className="tc-list-row__role">{payload?.role ?? 'unassigned'}</span>
                </div>
                <span className="tc-list-row__status">
                  <span className="tc-list-row__status-dot" aria-hidden="true" />
                  {payload?.agent === 'codex' ? 'codex' : 'claude'}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export function Canvas(): JSX.Element {
  return (
    <ReactFlowProvider>
      <FlowApp />
    </ReactFlowProvider>
  );
}

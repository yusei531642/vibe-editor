/**
 * Canvas — vibe-editor の無限キャンバスモード本体。
 *
 * Phase 3: AgentNodeCard + HandoffEdge + Workspace Preset 対応。
 * Rust 側 TeamHub から `team:handoff` event が来たら、from→to エッジを
 * 一時的に追加して 10 秒で自動 fade (#379)。
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
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
import {
  useCanvasNodes,
  useCanvasEdges,
  useCanvasStageView
} from '../../stores/canvas-selectors';
import { computeRecruitFocus } from '../../lib/canvas-recruit-focus';
import { KEYS, useKeybinding } from '../../lib/keybindings';
import { useUiStore } from '../../stores/ui';
import { ContextMenu, type ContextMenuItem } from '../ContextMenu';
import { useT } from '../../lib/i18n';
import { useConfirmRemoveCard } from '../../lib/use-confirm-remove-card';
import { useRoleProfiles } from '../../lib/role-profiles-context';
import { useSettings } from '../../lib/settings-context';
import { resolveAgentVisual, type AgentVisualPayload } from '../../lib/agent-visual';
import type { TeamOrganizationMeta } from '../../../../types/shared';

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

// React Flow に渡す静的な props はモジュール定数にしてレンダー間で参照を保つ。
// インラインオブジェクトだと毎レンダーで新しい識別子になり MiniMap / Background が
// memoization を活かせない。
const MINIMAP_STYLE = { background: '#0d0d12' } as const;
const MINIMAP_MASK_COLOR = 'rgba(0,0,0,0.6)';
const FLOW_DELETE_KEYS = ['Delete'];
const FLOW_PAN_BUTTONS = [0, 1, 2];
const FLOW_PRO_OPTIONS = { hideAttribution: true } as const;
const FLOW_STAGE_STYLE = { position: 'absolute' as const, inset: 0 };
// Issue #610: 旧実装は `<Background color="var(--canvas-grid, #1c1c20)" />` のように
//  CSS variable 文字列を SVG attribute に直接渡していたが、SVG attribute は CSS
//  context ではないため `var(...)` は解釈されず、ブラウザは attribute 値を不正
//  扱いして fallback の灰色 / 黒で固定描画していた (#585 縦線の根因)。
//  CSS で `.react-flow__background-pattern circle` の fill を `var(--canvas-grid)`
//  で上書きする方式 (styles/components/canvas.css 参照) に切替えたため、ここでは
//  color prop を渡さず、xyflow の default attribute の上に CSS が乗るようにする。
/** Issue #259 継承: zoom が 0.7 を下回ると TUI が読めなくなるため recruit focus 時のクランプ閾値。 */
const MIN_RECRUIT_ZOOM = 0.7;

function FlowApp(): JSX.Element {
  const t = useT();
  const nodes = useCanvasNodes();
  const edges = useCanvasEdges();
  // setNodes / setEdges / setViewport / addCard / pulseEdge / setTeamLock は zustand
  // 内部で stable identity を保つため selector で取り出してキャッシュしておく。
  const setNodes = useCanvasStore((s) => s.setNodes);
  const setEdges = useCanvasStore((s) => s.setEdges);
  const setViewport = useCanvasStore((s) => s.setViewport);
  const addCard = useCanvasStore((s) => s.addCard);
  // ユーザー操作 (× / 右クリック / Delete) からの削除はチーム全員カスケード前に確認を挟む。
  const confirmRemoveCard = useConfirmRemoveCard();
  const pulseEdge = useCanvasStore((s) => s.pulseEdge);
  const setTeamLock = useCanvasStore((s) => s.setTeamLock);
  const { settings } = useSettings();
  const { byId: profilesById } = useRoleProfiles();
  const resolveAccent = useCallback(
    (payload: AgentVisualPayload | undefined): string =>
      resolveAgentVisual(payload, profilesById, settings.language).agentAccent,
    [profilesById, settings.language]
  );
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
      // store から最新 nodes を直接取り出す (subscribe している `nodes` と等価だが、
      // ここで getState 越しに読むと callback の deps から `nodes` を外せる →
      // ドラッグ中に毎フレーム識別子が変わる onNodesChange を React Flow に再 bind せずに済む)。
      const currentNodes = useCanvasStore.getState().nodes;
      const nodesById = new Map<string, Node<CardData>>();
      const teamMembers = new Map<string, Node<CardData>[]>();
      for (const n of currentNodes) {
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
      setNodes(applyNodeChanges(allChanges, currentNodes));
    },
    [setNodes, confirmRemoveCard, isTeamLocked]
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) =>
      setEdges(applyEdgeChanges(changes, useCanvasStore.getState().edges)),
    [setEdges]
  );
  const onConnect = useCallback(
    (c: Connection) => setEdges(addEdge(c, useCanvasStore.getState().edges)),
    [setEdges]
  );

  // ----- 右クリックメニュー (カード単位) -----
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    items: ContextMenuItem[];
  } | null>(null);

  // Ctrl+Space / Pane 右クリック共通: 新規 AI Agent (Claude Code) を追加。
  // 件数カウントは getState で都度参照し、callback 識別子を `nodes` の参照変化から切り離す
  // (ドラッグ中の毎フレーム再生成を抑え、useKeybinding の listener 再登録も発生させない)。
  const handleAddClaudeAgent = useCallback((): void => {
    const currentNodes = useCanvasStore.getState().nodes;
    const n = currentNodes.filter((x) => x.type === 'agent').length + 1;
    addCard({
      type: 'agent',
      title: `Claude #${n}`,
      payload: { agent: 'claude', role: 'leader' }
    });
  }, [addCard]);

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
      // Issue #616 / #593: stopPropagation を抜いていたため React Flow の pane の
      //  mousedown が document まで bubble し、ContextMenu 内の outside-click 検知
      //  に「メニューを開いた当の右クリック自身」が外クリックとして誤検出されて
      //  即閉じる race を起こしていた (handleNodeContextMenu は両方呼んでいるので
      //  node 上の右クリックは正常)。Pane 経路にも stopPropagation を揃える。
      e.stopPropagation();
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
      data: { color: resolveAccent({ roleProfileId: p.fromRole }), preview: p.preview, fromRole: p.fromRole }
    });
  });

  const minimapColor = useCallback((node: Node) => {
    const data = node.data as CardData | undefined;
    if (data?.cardType === 'agent') {
      return resolveAccent(data.payload as AgentVisualPayload | undefined);
    }
    return '#7a7afd';
  }, [resolveAccent]);

  const initialViewport = useMemo(() => useCanvasStore.getState().viewport, []);

  // ---- Phase 4: keybindings ----
  const setViewMode = useUiStore((s) => s.setViewMode);
  // Issue #613: <CanvasLayout> は IDE モードでも常時 mount されているため、Canvas 内の
  //  useKeybinding が IDE モード中も capture phase で window keydown を奪っていた。
  //  Ctrl+Shift+K (QuickNav) / Ctrl+Shift+I (Inspector ≒ DevTools) / Ctrl+Shift+N (新規 agent)
  //  は **Canvas モード時のみ** 有効にして、IDE 中は Chromium 標準ショートカット (DevTools) や
  //  通常の入力に影響を与えないようにする。
  const isCanvasActive = useUiStore((s) => s.viewMode === 'canvas');
  const [quickNavOpen, setQuickNavOpen] = useState(false);
  useKeybinding(KEYS.quickNav, () => setQuickNavOpen(true), isCanvasActive);
  useKeybinding(KEYS.toggleIde, () => setViewMode('ide'), isCanvasActive);
  useKeybinding(KEYS.newTerminal, handleAddClaudeAgent, isCanvasActive);

  const stageView = useCanvasStageView();

  // Issue #253 / #372: recruit 後に viewport を「新規 worker カード」中心へ寄せる。
  // lastRecruitFocus は use-recruit-listener が `notifyRecruit(newNodeId)` で書き、
  // 本 effect が変化を検知して `setCenter` する。HR が worker を増やすケースでも
  // Leader ではなく追加された worker を中心にできる。
  //
  // 200ms debounce: 新ノードの DOM 計測完了 (~16ms) を待ちつつ、連続 recruit (Leader+5 等)
  // でアニメーションがカクつくのを回避。
  //
  // Issue #259 (継承): zoom が MIN_RECRUIT_ZOOM を下回ると TUI が読めなくなるため、
  // 現在の zoom がそれより大きければ尊重し、下回っていれば minZoom にクランプして寄せる。
  // (MIN_RECRUIT_ZOOM はモジュールトップで定義)
  // 旧 #372 review (vibe-editor-reviewer #418): selector で `lastRecruitFocus` を
  // オブジェクトのまま購読すると、zustand が毎回新しい参照を返すため effect deps が
  // 「object reference に敏感」になり、useReactFlow の参照変化と組み合わさって
  // 過剰再実行に繋がりうる。primitive (`nodeId` / `requestedAt`) だけを deps に置き、
  // 旧 trigger (`requestedAt`) が変化したときだけ effect を発火させる。
  const recruitFocusNodeId = useCanvasStore(
    (s) => s.lastRecruitFocus?.nodeId ?? null
  );
  const recruitFocusRequestedAt = useCanvasStore(
    (s) => s.lastRecruitFocus?.requestedAt ?? 0
  );
  const reactFlow = useReactFlow();
  useEffect(() => {
    if (!recruitFocusNodeId || !recruitFocusRequestedAt) return;
    const timer = window.setTimeout(() => {
      try {
        const targetNode = reactFlow.getNode(recruitFocusNodeId);
        // recruit cancel 等で対象ノードが消えていれば no-op
        if (!targetNode) return;
        const vp = reactFlow.getViewport();
        const focus = computeRecruitFocus({
          node: targetNode,
          currentZoom: vp.zoom,
          minZoom: MIN_RECRUIT_ZOOM,
          fallbackWidth: NODE_W,
          fallbackHeight: NODE_H
        });
        if (!focus) return;
        reactFlow.setCenter(focus.centerX, focus.centerY, {
          zoom: focus.zoom,
          duration: 300
        });
      } catch {
        /* viewport 計算に失敗するレアケースは無視 */
      }
    }, 200);
    return () => window.clearTimeout(timer);
  }, [recruitFocusNodeId, recruitFocusRequestedAt, reactFlow]);

  return (
    <div
      className="tc-stage-root"
      data-view={stageView}
      style={FLOW_STAGE_STYLE}
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
        deleteKeyCode={FLOW_DELETE_KEYS}
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
        panOnDrag={FLOW_PAN_BUTTONS}
        // onlyRenderVisibleElements は付けない。
        // 付けると React Flow がビューポート外のカードを DOM からアンマウントし、
        // TerminalCard 配下の usePtySession クリーンアップが走って PTY (= Claude/Codex)
        // ごと kill されてしまう。
        // パンで視点を動かしただけで Claude が死ぬのは UX として許容できないので、
        // 多少の DOM 増加は呑んで全カードを常時マウントしておく。
        proOptions={FLOW_PRO_OPTIONS}
      >
        <Background gap={32} />
        {/* React Flow デフォルトの白い縦 4 ボタン (zoom/+/-、fit、lock) は UI と不整合なので非表示。
            ズームはマウスホイール / トラックパッド、fit はキー (KEYS.fitView)、lock は不要なため。 */}
        <MiniMap
          pannable
          zoomable
          nodeColor={minimapColor}
          maskColor={MINIMAP_MASK_COLOR}
          style={MINIMAP_STYLE}
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
  const nodes = useCanvasNodes();
  const { settings } = useSettings();
  const { byId: profilesById } = useRoleProfiles();
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
              | {
                  roleProfileId?: string;
                  role?: string;
                  agentId?: string;
                  agent?: string;
                  organization?: TeamOrganizationMeta;
                }
              | undefined;
            const visual = resolveAgentVisual(payload, profilesById, settings.language);
            const rowStyle = {
              ['--agent-accent' as string]: visual.agentAccent,
              ['--organization-accent' as string]: visual.organizationAccent,
              ['--role-color' as string]: visual.agentAccent
            } as CSSProperties;
            return (
              <div key={n.id} className="tc-list-row" style={rowStyle}>
                <span className="tc-list-row__avatar">
                  {visual.glyph}
                </span>
                <div className="tc-list-row__id">
                  <span className="tc-list-row__name">{(n.data as CardData | undefined)?.title}</span>
                  <span className="tc-list-row__role">{visual.label}</span>
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

/**
 * Canvas — vibe-editor の無限キャンバスモード本体。
 *
 * Phase 3: AgentNodeCard + HandoffEdge + Workspace Preset 対応。
 * Rust 側 TeamHub から `team:handoff` event が来たら、from→to エッジを
 * 一時的に追加して 1.5 秒で自動 fade。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import TerminalCard from './cards/TerminalCard';
import AgentNodeCard from './cards/AgentNodeCard';
import EditorCard from './cards/EditorCard';
import DiffCard from './cards/DiffCard';
import FileTreeCard from './cards/FileTreeCard';
import ChangesCard from './cards/ChangesCard';
import HandoffEdge from './HandoffEdge';
import { QuickNav } from './QuickNav';
import { useCanvasStore, type CardData } from '../../stores/canvas';
import { colorOf } from '../../lib/team-roles';
import { KEYS, useKeybinding } from '../../lib/keybindings';
import { useUiStore } from '../../stores/ui';

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

interface HandoffPayload {
  teamId: string;
  fromAgentId: string;
  fromRole: string;
  toAgentId: string;
  toRole: string;
  preview: string;
  messageId: number;
  timestamp: string;
}

function FlowApp(): JSX.Element {
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const setNodes = useCanvasStore((s) => s.setNodes);
  const setEdges = useCanvasStore((s) => s.setEdges);
  const setViewport = useCanvasStore((s) => s.setViewport);
  const addCard = useCanvasStore((s) => s.addCard);
  const pulseEdge = useCanvasStore((s) => s.pulseEdge);

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<CardData>>[]) => setNodes(applyNodeChanges(changes, nodes)),
    [nodes, setNodes]
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => setEdges(applyEdgeChanges(changes, edges)),
    [edges, setEdges]
  );
  const onConnect = useCallback(
    (c: Connection) => setEdges(addEdge(c, edges)),
    [edges, setEdges]
  );

  // hand-off event を listen → 該当 agent ノード間に一時 edge を追加
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    void listen<HandoffPayload>('team:handoff', (e) => {
      const p = e.payload;
      // ノード id を agentId から逆引き
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
    }).then((u) => {
      if (cancelled) {
        u();
      } else {
        unlisten = u;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [pulseEdge]);

  const minimapColor = useCallback((node: Node) => {
    const data = node.data as CardData | undefined;
    if (data?.cardType === 'agent') {
      const role = (data.payload as { role?: string } | undefined)?.role;
      return colorOf(role);
    }
    return '#7a7afd';
  }, []);

  // Ctrl+Space: 新規 AI Agent (Claude Code) を追加
  const handleAddClaudeAgent = useCallback((): void => {
    const n = nodes.filter((x) => x.type === 'agent').length + 1;
    addCard({
      type: 'agent',
      title: `Claude #${n}`,
      payload: { agent: 'claude', role: 'leader' }
    });
  }, [addCard, nodes]);

  const initialViewport = useMemo(() => useCanvasStore.getState().viewport, []);

  // ---- Phase 4: keybindings ----
  const setViewMode = useUiStore((s) => s.setViewMode);
  const [quickNavOpen, setQuickNavOpen] = useState(false);
  useKeybinding(KEYS.quickNav, () => setQuickNavOpen(true));
  useKeybinding(KEYS.toggleIde, () => setViewMode('ide'));
  useKeybinding(KEYS.newTerminal, handleAddClaudeAgent);

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onMoveEnd={(_, vp) => setViewport(vp)}
        defaultViewport={initialViewport}
        // xterm はコンテナの CSS 座標で文字セルを計算するが、React Flow の
        // CSS transform: scale() による zoom は xterm の getBoundingClientRect と
        // 内部 cell width の比率を破壊する。実用範囲に絞ることで誤差を抑える。
        minZoom={0.5}
        maxZoom={1.5}
        fitView={nodes.length > 0}
        onlyRenderVisibleElements
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={32} color="var(--canvas-grid, #1c1c20)" />
        <Controls position="bottom-left" />
        <MiniMap
          pannable
          zoomable
          nodeColor={minimapColor}
          maskColor="rgba(0,0,0,0.6)"
          style={{ background: '#0d0d12' }}
        />
      </ReactFlow>

      <QuickNav open={quickNavOpen} onClose={() => setQuickNavOpen(false)} />
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

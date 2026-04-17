/**
 * Canvas store — React Flow の nodes/edges を保持し localStorage 永続化する。
 *
 * Phase 2 では「Card 配置の自由レイアウト」だけを支える最小実装。
 * Phase 3 以降で agent ノード / hand-off エッジを正規化していく。
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Edge, Node, Viewport } from '@xyflow/react';

export type CardType = 'terminal' | 'agent' | 'editor' | 'diff' | 'fileTree' | 'changes';

export interface CardData extends Record<string, unknown> {
  cardType: CardType;
  title: string;
  /** terminal の sessionId / editor の filePath 等 */
  payload?: unknown;
}

interface CanvasState {
  nodes: Node<CardData>[];
  edges: Edge[];
  viewport: Viewport;
  setNodes: (nodes: Node<CardData>[]) => void;
  setEdges: (edges: Edge[]) => void;
  setViewport: (v: Viewport) => void;
  addCard: (card: {
    type: CardType;
    title: string;
    payload?: unknown;
    /** 明示位置 (preset 用) */
    position?: { x: number; y: number };
  }) => string;
  /** 複数 Card をまとめて配置 (preset 適用用)。1 トランザクションで永続化される */
  addCards: (
    cards: { type: CardType; title: string; payload?: unknown; position: { x: number; y: number } }[]
  ) => string[];
  removeCard: (id: string) => void;
  /** カードのタイトルを更新 (auto-summary や rename 用) */
  setCardTitle: (id: string, title: string) => void;
  /** 一時的な hand-off edge を追加し N ms 後に自動削除 */
  pulseEdge: (edge: Edge, ttlMs?: number) => void;
  clear: () => void;
}

const NODE_W = 480;
const NODE_H = 320;

let counter = 0;
function newId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export const useCanvasStore = create<CanvasState>()(
  persist(
    (set, get) => ({
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      setNodes: (nodes) => set({ nodes }),
      setEdges: (edges) => set({ edges }),
      setViewport: (viewport) => set({ viewport }),
      addCard: ({ type, title, payload, position }) => {
        const id = newId(type);
        const existing = get().nodes;
        let pos = position;
        if (!pos) {
          // 簡易: 6 列グリッドで右下に積む
          const idx = existing.length;
          const cols = 6;
          pos = {
            x: (idx % cols) * (NODE_W + 32),
            y: Math.floor(idx / cols) * (NODE_H + 32)
          };
        }
        set({
          nodes: [
            ...existing,
            {
              id,
              type,
              position: pos,
              data: { cardType: type, title, payload },
              style: { width: NODE_W, height: NODE_H }
            }
          ]
        });
        return id;
      },
      addCards: (cards) => {
        const ids: string[] = [];
        const newNodes: Node<CardData>[] = cards.map((c) => {
          const id = newId(c.type);
          ids.push(id);
          return {
            id,
            type: c.type,
            position: c.position,
            data: { cardType: c.type, title: c.title, payload: c.payload },
            style: { width: NODE_W, height: NODE_H }
          };
        });
        set({ nodes: [...get().nodes, ...newNodes] });
        return ids;
      },
      removeCard: (id) =>
        set({
          nodes: get().nodes.filter((n) => n.id !== id),
          edges: get().edges.filter((e) => e.source !== id && e.target !== id)
        }),
      setCardTitle: (id, title) =>
        set({
          nodes: get().nodes.map((n) =>
            n.id === id ? { ...n, data: { ...n.data, title } } : n
          )
        }),
      pulseEdge: (edge, ttlMs = 1500) => {
        set({ edges: [...get().edges.filter((e) => e.id !== edge.id), edge] });
        setTimeout(() => {
          set({ edges: get().edges.filter((e) => e.id !== edge.id) });
        }, ttlMs);
      },
      clear: () => set({ nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } })
    }),
    {
      name: 'vibe-editor:canvas',
      // 永続化: nodes と viewport のみ。edges は一時的な hand-off アニメに使うので含めない
      partialize: (s) => ({ nodes: s.nodes, viewport: s.viewport })
    }
  )
);

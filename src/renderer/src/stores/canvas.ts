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
  /** カードの payload を浅くマージ更新する。
   *  Claude Code のセッション id 検出時に `resumeSessionId` を後追いで埋める用途。
   *  これにより次回 mount (アプリ再起動 / カード再表示) で `--resume <id>` を付与できる。 */
  setCardPayload: (id: string, patch: Record<string, unknown>) => void;
  /** 一時的な hand-off edge を追加し N ms 後に自動削除 */
  pulseEdge: (edge: Edge, ttlMs?: number) => void;
  clear: () => void;
  /** Canvas の見え方切替: stage=ラジアル / list=リスト / focus=フォーカス */
  stageView: StageView;
  setStageView: (v: StageView) => void;
  /** teamId ごとの「カードを一緒に動かすか」状態。
   *  未設定は「ロック (= 一緒に動く)」がデフォルト。
   *  チーム編成時は一緒に動かしたいケースが多いので、明示的に解除されるまでロック扱い。 */
  teamLocks: Record<string, boolean>;
  setTeamLock: (teamId: string, locked: boolean) => void;
  isTeamLocked: (teamId: string) => boolean;
}

export type StageView = 'stage' | 'list' | 'focus';

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
        set((state) => {
          // チームカードを 1 枚閉じたら、同 teamId の全メンバーを連動して閉じる。
          // 「team を閉じる = チーム単位で閉じる」のが自然な期待値なので、
          // どのエントリポイント (×ボタン / 右クリック / Delete キー) からでも
          // このアクションに集約する。
          const target = state.nodes.find((n) => n.id === id);
          const teamId = (target?.data?.payload as { teamId?: string } | undefined)?.teamId;
          const ids = new Set<string>([id]);
          let teamLocksNext = state.teamLocks;
          if (teamId) {
            for (const n of state.nodes) {
              const tid = (n.data?.payload as { teamId?: string } | undefined)?.teamId;
              if (tid === teamId) ids.add(n.id);
            }
            // ロック状態も一緒に掃除 (再度同じ teamId を立てる将来のために残骸を残さない)
            if (teamId in state.teamLocks) {
              const next = { ...state.teamLocks };
              delete next[teamId];
              teamLocksNext = next;
            }
          }
          return {
            nodes: state.nodes.filter((n) => !ids.has(n.id)),
            edges: state.edges.filter(
              (e) => !ids.has(e.source) && !ids.has(e.target)
            ),
            teamLocks: teamLocksNext
          };
        }),
      setCardTitle: (id, title) =>
        set({
          nodes: get().nodes.map((n) =>
            n.id === id ? { ...n, data: { ...n.data, title } } : n
          )
        }),
      setCardPayload: (id, patch) =>
        set({
          nodes: get().nodes.map((n) => {
            if (n.id !== id) return n;
            const prev = (n.data?.payload as Record<string, unknown> | undefined) ?? {};
            return {
              ...n,
              data: { ...n.data, payload: { ...prev, ...patch } }
            };
          })
        }),
      pulseEdge: (edge, ttlMs = 1500) => {
        set({ edges: [...get().edges.filter((e) => e.id !== edge.id), edge] });
        setTimeout(() => {
          set({ edges: get().edges.filter((e) => e.id !== edge.id) });
        }, ttlMs);
      },
      clear: () => set({ nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, teamLocks: {} }),
      stageView: 'stage',
      setStageView: (v) => set({ stageView: v }),
      teamLocks: {},
      setTeamLock: (teamId, locked) =>
        set({ teamLocks: { ...get().teamLocks, [teamId]: locked } }),
      isTeamLocked: (teamId) => {
        const v = get().teamLocks[teamId];
        return v === undefined ? true : v;
      }
    }),
    {
      name: 'vibe-editor:canvas',
      // 永続化: nodes / viewport / stageView / teamLocks。
      // edges は一時的な hand-off アニメに使うので含めない。
      partialize: (s) => ({
        nodes: s.nodes,
        viewport: s.viewport,
        stageView: s.stageView,
        teamLocks: s.teamLocks
      })
    }
  )
);

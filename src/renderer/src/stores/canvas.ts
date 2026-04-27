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
  /** カードを 1 枚削除する。
   *  デフォルトは teamId が一致する仲間カードを「チーム単位」で全部閉じる挙動 (× ボタン等の UX)。
   *  `cascadeTeam: false` を渡すと指定 id 1 枚だけを閉じる (`team_dismiss` で 1 名解雇する経路で使う)。 */
  removeCard: (id: string, options?: { cascadeTeam?: boolean }) => void;
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
  /** 指定 teamId のメンバーを Leader 直下の 3 列グリッドに整列し直す。
   *  リーダーは現在位置を維持し、その他メンバーが整列対象。
   *  右クリック → 自動整理 メニューから呼ばれる。 */
  autoArrangeTeam: (teamId: string) => void;
}

export type StageView = 'stage' | 'list' | 'focus';

const NODE_W = 480;
const NODE_H = 320;

/**
 * Issue #157: 旧 `Date.now() + counter` 方式は zustand persist 復元 + リロード後の
 * counter リセットで稀に衝突しうる。crypto.randomUUID() で衝突確率を実質ゼロに。
 * (Tauri WebView2 / 主要ブラウザでサポート済み。fallback 環境では Math.random ベースで補う)。
 */
function newId(prefix: string): string {
  const u =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${u}`;
}

/**
 * Issue #156: pulseEdge の TTL 用 setTimeout ハンドルを edge.id ごとに保持する。
 * 同じ edge.id への連続 pulse は古い timer を clear して上書き、clear() / unmount で
 * 全件まとめて clear する。これにより:
 *  - 1.5s 以内に clear() が走った後の不要再描画を防ぐ
 *  - 大量 handoff 時の保留 timer 蓄積を抑える
 */
const pulseTimers = new Map<string, number>();

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
      removeCard: (id, options) =>
        set((state) => {
          const cascadeTeam = options?.cascadeTeam !== false; // 既定: チーム単位カスケード
          // cascadeTeam=true (× ボタン等): 同 teamId 全員を一括削除
          // cascadeTeam=false (team_dismiss 1 名解雇): 指定 id だけを閉じ、Leader や他メンバーは残す
          const target = state.nodes.find((n) => n.id === id);
          const teamId = (target?.data?.payload as { teamId?: string } | undefined)?.teamId;
          const ids = new Set<string>([id]);
          if (cascadeTeam && teamId) {
            for (const n of state.nodes) {
              const tid = (n.data?.payload as { teamId?: string } | undefined)?.teamId;
              if (tid === teamId) ids.add(n.id);
            }
          }
          return {
            nodes: state.nodes.filter((n) => !ids.has(n.id)),
            edges: state.edges.filter(
              (e) => !ids.has(e.source) && !ids.has(e.target)
            )
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
        // Issue #156: 同 id の前回 pulse タイマーを clear してから新規張り直し
        const prev = pulseTimers.get(edge.id);
        if (prev !== undefined) {
          window.clearTimeout(prev);
        }
        const handle = window.setTimeout(() => {
          pulseTimers.delete(edge.id);
          set({ edges: get().edges.filter((e) => e.id !== edge.id) });
        }, ttlMs);
        pulseTimers.set(edge.id, handle);
      },
      clear: () => {
        // Issue #156: pulse 用の保留タイマーを全件 clear して、clear 後の不要再描画を防ぐ
        for (const h of pulseTimers.values()) {
          window.clearTimeout(h);
        }
        pulseTimers.clear();
        set({ nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } });
      },
      stageView: 'stage',
      setStageView: (v) => set({ stageView: v }),
      autoArrangeTeam: (teamId) =>
        set((state) => {
          // チームメンバーを抽出
          const members = state.nodes.filter((n) => {
            const tid = (n.data?.payload as { teamId?: string } | undefined)?.teamId;
            return tid === teamId;
          });
          if (members.length === 0) return state;
          // Leader を特定 (role === 'leader')。見つからなければ最も左上のメンバーを leader 代用。
          const leader =
            members.find((n) => {
              const role = (n.data?.payload as { role?: string } | undefined)?.role;
              return role === 'leader';
            }) ??
            [...members].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)[0];
          // findRecruitPosition (use-recruit-listener.ts) と同じセル寸法・3 列グリッドで詰め直す。
          const COLS = 3;
          const GAP_X = 32;
          const GAP_Y = 60;
          const cellW = NODE_W + GAP_X;
          const cellH = NODE_H + GAP_Y;
          const startX = leader.position.x + NODE_W / 2 - (cellW * COLS) / 2 + GAP_X / 2;
          const startY = leader.position.y + NODE_H + GAP_Y;
          // members の登場順 (= 採用順) を保ったままインデックスを振り直す
          const others = members.filter((n) => n.id !== leader.id);
          const newPosById = new Map<string, { x: number; y: number }>();
          others.forEach((n, i) => {
            const col = i % COLS;
            const row = Math.floor(i / COLS);
            newPosById.set(n.id, {
              x: startX + col * cellW,
              y: startY + row * cellH
            });
          });
          return {
            nodes: state.nodes.map((n) => {
              const next = newPosById.get(n.id);
              return next ? { ...n, position: next } : n;
            })
          };
        })
    }),
    {
      name: 'vibe-editor:canvas',
      version: 2,
      migrate: (persisted, fromVersion) => {
        // v1 → v2: payload.role を payload.roleProfileId にリネーム
        // (role と roleProfileId 双方で参照される過渡期があるので、両方残す)
        if (fromVersion < 2 && persisted && typeof persisted === 'object' && 'nodes' in persisted) {
          const p = persisted as { nodes?: Array<Record<string, unknown>> };
          p.nodes = (p.nodes ?? []).map((n) => {
            const data = (n.data ?? {}) as Record<string, unknown>;
            const payload = (data.payload ?? {}) as Record<string, unknown>;
            if (typeof payload.role === 'string' && !payload.roleProfileId) {
              payload.roleProfileId = payload.role;
            }
            return { ...n, data: { ...data, payload } };
          });
        }
        return persisted as CanvasState;
      },
      // 永続化: nodes / viewport / stageView。
      // edges は一時的な hand-off アニメに使うので含めない。
      // teamLocks (旧「チーム固定」) は削除済み — 単独移動が常に正の挙動。
      partialize: (s) => ({
        nodes: s.nodes,
        viewport: s.viewport,
        stageView: s.stageView
      })
    }
  )
);

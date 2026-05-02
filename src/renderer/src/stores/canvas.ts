/**
 * Canvas store — React Flow の nodes/edges を保持し localStorage 永続化する。
 *
 * Phase 2 では「Card 配置の自由レイアウト」だけを支える最小実装。
 * Phase 3 以降で agent ノード / hand-off エッジを正規化していく。
 */
import { create } from 'zustand';
import { persist, subscribeWithSelector } from 'zustand/middleware';
import type { Edge, Node, Viewport } from '@xyflow/react';
import {
  tidyTerminals,
  unifyTerminalSize,
  type ArrangeGap
} from '../lib/canvas-arrange';

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
  /** teamId ごとの「カードを一緒に動かすか」状態。
   *  未設定は「ロック (= 一緒に動く)」がデフォルト。
   *  チーム編成時は一緒に動かしたいケースが多いので、明示的に解除されるまでロック扱い。 */
  teamLocks: Record<string, boolean>;
  setTeamLock: (teamId: string, locked: boolean) => void;
  isTeamLocked: (teamId: string) => boolean;
  /**
   * Issue #253 / #372: recruit イベント (新規メンバー追加) で viewport を新規 worker
   * 中心へ寄せるためのトリガー。use-recruit-listener が card 追加後に
   * `notifyRecruit(nodeId)` を呼び、Canvas component が useEffect でこの変化を検知して
   * `useReactFlow().setCenter(...)` で対象ノードを中央に置く。
   *
   * `nodeId` を含めることで、HR から worker を増やすケース等でも「Leader ではなく
   * 直前に追加された worker」を中心に置けるようにする (#372)。連続 recruit のうち
   * 最後の 1 件だけが effect で消費される (古い trigger は debounce 内で上書き)。
   */
  lastRecruitFocus: { nodeId: string; requestedAt: number } | null;
  notifyRecruit: (nodeId: string) => void;
  /**
   * Issue #369: Canvas 内の terminal / agent カードを一括整理整頓する。
   * 既存 PTY を維持するため node id / data / payload は触らず、
   * position と style.width/height だけを更新する。
   * 次回 `tidyTerminals` 用に最後に選ばれた gap も保存しておく。
   */
  arrangeGap: ArrangeGap;
  setArrangeGap: (gap: ArrangeGap) => void;
  tidyTerminalCards: (gap?: ArrangeGap) => void;
  unifyTerminalCardSize: () => void;
}

export type StageView = 'stage' | 'list' | 'focus';

/**
 * カード初期幅/高さ (新規 addCard 時に適用)。
 * Issue #253: 旧 480x320 では Codex/Claude TUI のヘッダーが折り返しで崩れがちだったため
 * 640x400 に引き上げ。永続化された旧サイズ (<=480 / <=320) のノードは persist v3 migration
 * で同じ値に拡大される。ユーザーが手動でそれより大きくリサイズした値は尊重。
 */
export const NODE_W = 640;
export const NODE_H = 400;
/**
 * NodeResizer の最小幅/高さ (ユーザーが手動縮小したときの下限)。
 * Issue #253: ターミナル UI が崩れず Codex/Claude TUI が読める下限として 480x280。
 * これ以下だとヘッダーボタン + ターミナル本体が窮屈になりすぎる。
 */
export const NODE_MIN_W = 480;
export const NODE_MIN_H = 280;
/** persist v3 で既存ユーザーのカードを引き上げる閾値 (これ以下のサイズなら NODE_W/H に拡大) */
const LEGACY_NODE_W_THRESHOLD = 480;
const LEGACY_NODE_H_THRESHOLD = 320;
const CARD_TYPES: CardType[] = ['terminal', 'agent', 'editor', 'diff', 'fileTree', 'changes'];
const STAGE_VIEWS: StageView[] = ['stage', 'list', 'focus'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCardType(value: unknown): value is CardType {
  return typeof value === 'string' && CARD_TYPES.includes(value as CardType);
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

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
  /**
   * Issue #253 sub: subscribeWithSelector で `subscribe(selector, listener)` API を有効化。
   * useCanvasTerminalFit の zoom 購読が selector subscribe に切り替えられ、量子化判定が
   * zustand 内部で行われるので毎フレーム数百回の callback ホットパスが消える。
   *
   * ★ MIDDLEWARE 順序の警告 (Issue #253 review W#2 / #7):
   *   `subscribeWithSelector` は **必ず persist の outer に置くこと**。逆順
   *   (`persist(subscribeWithSelector(...))`) にすると、persist が subscribe API をラップし
   *   直して `selector` 引数版 (selector subscribe) を吸収しないため、selector が listener
   *   として解釈されて毎フレーム発火する潜在的バグになる。型レベルでは検出されない (TS は
   *   subscribe の overload を判別できない)。
   *
   *   依存箇所:
   *   - `src/renderer/src/lib/use-canvas-terminal-fit.ts` の `zoomSubscribe` が
   *     `useCanvasStore.subscribe((s) => quantize(s.viewport.zoom), cb)` で selector subscribe
   *     を使う。middleware を外す/順序を変える前に必ず影響を確認すること。
   */
  subscribeWithSelector(
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
          // cascadeTeam=true (× ボタン等): 同 teamId 全員 + teamLocks も掃除
          // cascadeTeam=false (team_dismiss 1 名解雇): 指定 id だけを閉じ、Leader や他メンバーは残す
          const target = state.nodes.find((n) => n.id === id);
          const teamId = (target?.data?.payload as { teamId?: string } | undefined)?.teamId;
          const ids = new Set<string>([id]);
          let teamLocksNext = state.teamLocks;
          if (cascadeTeam && teamId) {
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
      pulseEdge: (edge, ttlMs = 10000) => {
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
        set({ nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, teamLocks: {} });
      },
      stageView: 'stage',
      setStageView: (v) => set({ stageView: v }),
      teamLocks: {},
      setTeamLock: (teamId, locked) =>
        set({ teamLocks: { ...get().teamLocks, [teamId]: locked } }),
      isTeamLocked: (teamId) => {
        const v = get().teamLocks[teamId];
        return v === undefined ? true : v;
      },
      // Issue #253 / #372: recruit 後の viewport 寄せトリガー
      // (use-recruit-listener が書き、Canvas が監視して setCenter する)
      lastRecruitFocus: null,
      notifyRecruit: (nodeId) =>
        set({ lastRecruitFocus: { nodeId, requestedAt: Date.now() } }),
      // Issue #369: terminal/agent カードの一括整理整頓
      arrangeGap: 'normal',
      setArrangeGap: (gap) => set({ arrangeGap: gap }),
      tidyTerminalCards: (gap) =>
        set((state) => ({
          nodes: tidyTerminals(state.nodes, { gap: gap ?? state.arrangeGap }),
          arrangeGap: gap ?? state.arrangeGap
        })),
      unifyTerminalCardSize: () =>
        set((state) => ({ nodes: unifyTerminalSize(state.nodes) }))
    }),
    {
      name: 'vibe-editor:canvas',
      version: 3,
      migrate: (persisted, fromVersion) => {
        if (!isRecord(persisted)) {
          return {
            nodes: [],
            viewport: { x: 0, y: 0, zoom: 1 },
            stageView: 'stage',
            teamLocks: {}
          } as Partial<CanvasState>;
        }
        // v1 → v2: payload.role を payload.roleProfileId にリネーム
        // (role と roleProfileId 双方で参照される過渡期があるので、両方残す)
        const p = { ...persisted } as Record<string, unknown>;
        if (fromVersion < 2 && Array.isArray(p.nodes)) {
          p.nodes = p.nodes.map((n) => {
            if (!isRecord(n)) return n;
            const data = (n.data ?? {}) as Record<string, unknown>;
            const payload = (data.payload ?? {}) as Record<string, unknown>;
            if (typeof payload.role === 'string' && !payload.roleProfileId) {
              payload.roleProfileId = payload.role;
            }
            return { ...n, data: { ...data, payload } };
          });
        }

        // v2 → v3 (Issue #253): 旧 NODE_W/H (480x320) で永続化された小さいカードを
        // NODE_W/H (640x400) に拡大する。ユーザーが手動でそれより大きくリサイズした
        // 値は尊重するため、`<= LEGACY_*_THRESHOLD` のときだけ引き上げる。
        // width/height は style に乗っているため style を直接書き換える。
        if (fromVersion < 3 && Array.isArray(p.nodes)) {
          p.nodes = p.nodes.map((n) => {
            if (!isRecord(n)) return n;
            const styleRaw = isRecord(n.style) ? n.style : {};
            const w = typeof styleRaw.width === 'number' ? styleRaw.width : undefined;
            const h = typeof styleRaw.height === 'number' ? styleRaw.height : undefined;
            const nextW = w !== undefined && w <= LEGACY_NODE_W_THRESHOLD ? NODE_W : w;
            const nextH = h !== undefined && h <= LEGACY_NODE_H_THRESHOLD ? NODE_H : h;
            if (nextW === w && nextH === h) return n;
            return {
              ...n,
              style: {
                ...styleRaw,
                ...(nextW !== undefined ? { width: nextW } : {}),
                ...(nextH !== undefined ? { height: nextH } : {})
              }
            };
          });
        }

        // 壊れた localStorage で ReactFlow が render 例外を出すと黒画面になるため、
        // 永続化データはバージョンに関係なく最低限の形へ正規化してから復元する。
        const nodes = Array.isArray(p.nodes)
          ? p.nodes
              .map((raw, index): Node<CardData> | null => {
                if (!isRecord(raw)) return null;
                const data = isRecord(raw.data) ? raw.data : {};
                const type = isCardType(raw.type)
                  ? raw.type
                  : isCardType(data.cardType)
                    ? data.cardType
                    : null;
                if (!type) return null;
                const positionRaw = isRecord(raw.position) ? raw.position : {};
                const styleRaw = isRecord(raw.style) ? raw.style : {};
                const title = typeof data.title === 'string' && data.title.trim()
                  ? data.title
                  : 'Card';
                return {
                  ...(raw as Partial<Node<CardData>>),
                  id: typeof raw.id === 'string' && raw.id ? raw.id : newId(type),
                  type,
                  position: {
                    x: finiteOr(positionRaw.x, (index % 6) * (NODE_W + 32)),
                    y: finiteOr(positionRaw.y, Math.floor(index / 6) * (NODE_H + 32))
                  },
                  data: {
                    ...data,
                    cardType: type,
                    title,
                    payload: data.payload
                  },
                  style: {
                    ...styleRaw,
                    width: finiteOr(styleRaw.width, NODE_W),
                    height: finiteOr(styleRaw.height, NODE_H)
                  }
                };
              })
              .filter((n): n is Node<CardData> => n !== null)
          : [];
        const viewportRaw = isRecord(p.viewport) ? p.viewport : {};
        return {
          ...p,
          nodes,
          viewport: {
            x: finiteOr(viewportRaw.x, 0),
            y: finiteOr(viewportRaw.y, 0),
            zoom: finiteOr(viewportRaw.zoom, 1)
          },
          stageView: STAGE_VIEWS.includes(p.stageView as StageView)
            ? (p.stageView as StageView)
            : 'stage',
          teamLocks: isRecord(p.teamLocks) ? p.teamLocks : {}
        } as Partial<CanvasState>;
      },
      // 永続化: nodes / viewport / stageView / teamLocks。
      // edges は一時的な hand-off アニメに使うので含めない。
      partialize: (s) => ({
        nodes: s.nodes,
        viewport: s.viewport,
        stageView: s.stageView,
        teamLocks: s.teamLocks,
        arrangeGap: s.arrangeGap
      })
    }
    )
  )
);

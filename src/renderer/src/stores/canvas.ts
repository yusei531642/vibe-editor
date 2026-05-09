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
import {
  NODE_W as NODE_W_DEFAULT,
  NODE_H as NODE_H_DEFAULT,
  __testables as MIGRATION_TESTABLES,
  newId,
  runCanvasMigration,
  normalizeCanvasState
} from '../lib/canvas-migrations';

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
  isDragging: boolean;
  setNodes: (nodes: Node<CardData>[]) => void;
  setEdges: (edges: Edge[]) => void;
  setViewport: (v: Viewport) => void;
  setCanvasDragging: (dragging: boolean) => void;
  /** clear() 後に React Flow の内部 viewport も同期リセットするための signal。 */
  viewportResetSeq: number;
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
 * 値の実体は `lib/canvas-migrations.ts` に集約 (persist v3 の閾値定数と一緒に管理する
 * ことで「初期サイズと migration 閾値が同期している」を読みやすくしている)。
 */
export const NODE_W = NODE_W_DEFAULT;
export const NODE_H = NODE_H_DEFAULT;
/**
 * NodeResizer の最小幅/高さ (ユーザーが手動縮小したときの下限)。
 * Issue #253: ターミナル UI が崩れず Codex/Claude TUI が読める下限として 480x280。
 * これ以下だとヘッダーボタン + ターミナル本体が窮屈になりすぎる。
 */
export const NODE_MIN_W = 480;
export const NODE_MIN_H = 280;

/**
 * Issue #156: pulseEdge の TTL 用 setTimeout ハンドルを edge.id ごとに保持する。
 * 同じ edge.id への連続 pulse は古い timer を clear して上書き、clear() / unmount で
 * 全件まとめて clear する。これにより:
 *  - 1.5s 以内に clear() が走った後の不要再描画を防ぐ
 *  - 大量 handoff 時の保留 timer 蓄積を抑える
 */
const pulseTimers = new Map<string, number>();

/** Issue #385: テストから直接 normalize の挙動を検証するための export。
 *  本体は zustand persist の migrate / merge から間接呼出しされるが、unit test では
 *  この export を使って壊れた localStorage 入力 / 極端な viewport などの境界条件を確認する。
 *  実体は `lib/canvas-migrations.ts` 側に移し、こちらは互換維持のための re-export。 */
export const __testables = MIGRATION_TESTABLES;

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
      isDragging: false,
      viewportResetSeq: 0,
      setNodes: (nodes) => set({ nodes }),
      setEdges: (edges) => set({ edges }),
      setViewport: (viewport) => set({ viewport }),
      setCanvasDragging: (isDragging) => set({ isDragging }),
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
        set((state) => ({
          nodes: [],
          edges: [],
          viewport: { x: 0, y: 0, zoom: 1 },
          viewportResetSeq: state.viewportResetSeq + 1,
          teamLocks: {}
        }));
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
      // Issue #385: v4 で persisted state は必ず normalizeCanvasState を経由させる。
      // 同 version の rehydrate でも `merge` で再正規化するため、runtime で紛れ込んだ
      // NaN viewport / 範囲外 zoom / 壊れた node も次回起動時には掃除される。
      // Issue #497: v5 で旧既定 640x400 のカードを新既定 760x460 へ移行する
      // (>640 / >400 の手動拡大値は尊重)。詳細は `lib/canvas-migrations.ts` の v4 step。
      version: 5,
      // 各 version の差分は `lib/canvas-migrations.ts` の `MIGRATION_STEPS` に集約。
      // ここでは「fromVersion → 最新」を 1 行で進めるだけ。最後に必ず normalize を通すので
      // 同 version の rehydrate でも runtime に紛れ込んだ NaN viewport / 範囲外 zoom /
      // 壊れた node が掃除され、Canvas 真っ黒の症状を防ぐ。
      migrate: (persisted, fromVersion) =>
        runCanvasMigration(persisted, fromVersion) as Partial<CanvasState>,
      // Issue #385: 同 version でも rehydrate のたびに normalize を走らせる。
      // 旧実装は migrate 経由の正規化だけだったため、現バージョンで保存された
      // 不正値 (極端な viewport 等) を起動時に拾えず、Canvas 真っ黒の症状を引き起こしていた。
      merge: (persisted, current) => {
        const normalized = normalizeCanvasState(persisted);
        return { ...current, ...normalized };
      },
      // 永続化: nodes / viewport / stageView / teamLocks / arrangeGap。
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

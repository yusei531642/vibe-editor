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
   * Issue #253: recruit イベント (新規メンバー追加) で fitView を発火させるためのトリガー。
   * use-recruit-listener が card 追加後に Date.now() を書き、Canvas component が
   * useEffect で監視して `useReactFlow().fitView({ padding: 0.15, duration: 300 })` を呼ぶ。
   * RECRUIT_RADIUS = NODE_W + 80 により論理幅 2080 px 超を要求する 6 名同心円配置でも、
   * fitView で全員が viewport に収まるよう自動調整する。
   */
  lastRecruitAt: number | null;
  notifyRecruit: () => void;
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
 * Issue #385: Canvas viewport の `zoom` を可視範囲にクランプし、
 * `x` / `y` が極端な値 (= 全カードが viewport 外) のときは復帰用の値に戻す。
 * これらは render 中に React Flow が黒画面化する/カードが見えなくなる主要因。
 */
const VIEWPORT_MIN_ZOOM = 0.1;
const VIEWPORT_MAX_ZOOM = 4;
/** nodes ありで viewport がここまで離れていたら「外れすぎ」と判定して復帰用 viewport にする */
const VIEWPORT_RESCUE_DISTANCE = 1_000_000;

function clampZoom(zoom: number): number {
  // NaN は単位が無いので 1 (= 等倍) にフォールバック。±Infinity は Math.min/max で
  // それぞれ MAX_ZOOM / MIN_ZOOM にクランプされる。
  if (Number.isNaN(zoom)) return 1;
  return Math.min(Math.max(zoom, VIEWPORT_MIN_ZOOM), VIEWPORT_MAX_ZOOM);
}

interface NormalizedCanvasState {
  nodes: Node<CardData>[];
  viewport: Viewport;
  stageView: StageView;
  teamLocks: Record<string, boolean>;
  arrangeGap: ArrangeGap;
}

/**
 * 永続化データ / merge 入力を React Flow が安全に描画できる形へ正規化する。
 * - nodes: 必須プロパティの欠損 / 不正値を補い、type 不明な要素は捨てる
 * - viewport.zoom: [VIEWPORT_MIN_ZOOM, VIEWPORT_MAX_ZOOM] にクランプ
 * - viewport.x/y: 非有限なら 0、極端な値で nodes が完全に外れていれば nodes 中心へ復帰
 * - stageView / teamLocks / arrangeGap: 不正な値ならデフォルトに戻す
 */
function normalizeCanvasState(input: unknown): NormalizedCanvasState {
  const p = isRecord(input) ? input : {};
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
          const title =
            typeof data.title === 'string' && data.title.trim()
              ? data.title
              : 'Card';
          // Issue #385 (codex review #3): node.position が有限値でも極端 (|x|>1M 等)
          // だと viewport が正常でもカードが viewport 外で見えず実質黒画面になる。
          // rescue 距離を超える座標は fallback grid に戻して可視性を担保する。
          const rawX = finiteOr(positionRaw.x, (index % 6) * (NODE_W + 32));
          const rawY = finiteOr(positionRaw.y, Math.floor(index / 6) * (NODE_H + 32));
          const safeX =
            Math.abs(rawX) > VIEWPORT_RESCUE_DISTANCE
              ? (index % 6) * (NODE_W + 32)
              : rawX;
          const safeY =
            Math.abs(rawY) > VIEWPORT_RESCUE_DISTANCE
              ? Math.floor(index / 6) * (NODE_H + 32)
              : rawY;
          return {
            ...(raw as Partial<Node<CardData>>),
            id: typeof raw.id === 'string' && raw.id ? raw.id : newId(type),
            type,
            position: { x: safeX, y: safeY },
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
  let vpX = finiteOr(viewportRaw.x, 0);
  let vpY = finiteOr(viewportRaw.y, 0);
  // viewport.zoom は clampZoom 側で NaN→1 / ±Infinity→MAX/MIN を吸収する。
  // finiteOr で潰すと Infinity が 1 にフォールバックされて clamp 仕様が崩れるので注意。
  const vpZoom = clampZoom(
    typeof viewportRaw.zoom === 'number' ? viewportRaw.zoom : 1
  );
  // nodes があるのに viewport がカード群から大きく外れていたら、nodes の中心 (= 0,0 周辺の代表点)
  // へ寄せる。React Flow は座標を pan で表現するので、x/y が ±VIEWPORT_RESCUE_DISTANCE を
  // 超えていたら現実的な操作で戻れない位置と判定。
  if (
    nodes.length > 0 &&
    (Math.abs(vpX) > VIEWPORT_RESCUE_DISTANCE ||
      Math.abs(vpY) > VIEWPORT_RESCUE_DISTANCE)
  ) {
    vpX = 0;
    vpY = 0;
  }
  const teamLocks = isRecord(p.teamLocks)
    ? Object.fromEntries(
        Object.entries(p.teamLocks).filter(([, v]) => typeof v === 'boolean')
      )
    : {};
  const stageView = STAGE_VIEWS.includes(p.stageView as StageView)
    ? (p.stageView as StageView)
    : 'stage';
  const arrangeGap = ((): ArrangeGap => {
    const gap = p.arrangeGap;
    return gap === 'tight' || gap === 'normal' || gap === 'roomy'
      ? gap
      : 'normal';
  })();
  return {
    nodes,
    viewport: { x: vpX, y: vpY, zoom: vpZoom },
    stageView,
    teamLocks,
    arrangeGap
  };
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

/** Issue #385: テストから直接 normalize の挙動を検証するための export。
 *  本体は zustand persist の migrate / merge から間接呼出しされるが、unit test では
 *  この export を使って壊れた localStorage 入力 / 極端な viewport などの境界条件を確認する。 */
export const __testables = {
  normalizeCanvasState,
  VIEWPORT_MIN_ZOOM,
  VIEWPORT_MAX_ZOOM,
  VIEWPORT_RESCUE_DISTANCE
};

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
      // Issue #253: recruit 後の fitView トリガー (use-recruit-listener が書き、Canvas が監視)
      lastRecruitAt: null,
      notifyRecruit: () => set({ lastRecruitAt: Date.now() }),
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
      // Issue #385: v4 へ bump し、persisted state は必ず normalizeCanvasState を経由
      // させる。同 version の rehydrate でも `merge` で再正規化するため、runtime で
      // 紛れ込んだ NaN viewport / 範囲外 zoom / 壊れた node も次回起動時には掃除される。
      version: 4,
      migrate: (persisted, fromVersion) => {
        if (!isRecord(persisted)) {
          return normalizeCanvasState({}) as Partial<CanvasState>;
        }
        const p: Record<string, unknown> = { ...persisted };
        // v1 → v2: payload.role を payload.roleProfileId にリネーム
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
        // v2 → v3 (Issue #253): 旧 NODE_W/H (480x320) → 640x400。ユーザーが手動拡大した
        // 値は尊重するため <= LEGACY_*_THRESHOLD のときだけ引き上げ。
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
        // v3 → v4 (Issue #385): 構造変換は不要 (normalize で吸収する)。
        return normalizeCanvasState(p) as Partial<CanvasState>;
      },
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

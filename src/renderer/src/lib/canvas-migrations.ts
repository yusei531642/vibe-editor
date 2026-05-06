/**
 * Canvas store の persist 正規化 / version migration を集約するモジュール。
 *
 * `stores/canvas.ts` から切り出した理由:
 *   - normalizeCanvasState は zustand persist の `migrate` / `merge` 両方から呼ばれる
 *     pure function であり、store 本体 (action 群) と関心が分離している。
 *   - version → migration 関数のテーブル化により「どの version で何を変えたか」が
 *     一覧で読める形になり、新たな persist version bump 時の追記場所も明確になる。
 *
 * テストは `__testables` 経由で zustand 内部に依存せず正規化ロジックを検証できる。
 * 既存 `canvas-restore-normalize.test.ts` / `canvas-migrate.test.ts` は変更不要。
 */
import type { Node, Viewport } from '@xyflow/react';
import type { ArrangeGap } from './canvas-arrange';
import type { CardData, CardType, StageView } from '../stores/canvas';

/**
 * カード初期幅/高さ。stores/canvas.ts と同期させること。
 * Issue #253: 旧 480x320 では Codex/Claude TUI のヘッダーが折り返しで崩れがちだったため
 * 640x400 に引き上げ。
 */
export const NODE_W = 640;
export const NODE_H = 400;

/** persist v3 で既存ユーザーのカードを引き上げる閾値 (これ以下のサイズなら NODE_W/H に拡大) */
const LEGACY_NODE_W_THRESHOLD = 480;
const LEGACY_NODE_H_THRESHOLD = 320;

const CARD_TYPES: CardType[] = ['terminal', 'agent', 'editor', 'diff', 'fileTree', 'changes'];
const STAGE_VIEWS: StageView[] = ['stage', 'list', 'focus'];

/**
 * Issue #385: Canvas viewport の `zoom` を可視範囲にクランプし、
 * `x` / `y` が極端な値 (= 全カードが viewport 外) のときは復帰用の値に戻す。
 * これらは render 中に React Flow が黒画面化する/カードが見えなくなる主要因。
 */
export const VIEWPORT_MIN_ZOOM = 0.1;
export const VIEWPORT_MAX_ZOOM = 4;
/** nodes ありで viewport がここまで離れていたら「外れすぎ」と判定して復帰用 viewport にする */
export const VIEWPORT_RESCUE_DISTANCE = 1_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCardType(value: unknown): value is CardType {
  return typeof value === 'string' && CARD_TYPES.includes(value as CardType);
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clampZoom(zoom: number): number {
  // NaN は単位が無いので 1 (= 等倍) にフォールバック。±Infinity は Math.min/max で
  // それぞれ MAX_ZOOM / MIN_ZOOM にクランプされる。
  if (Number.isNaN(zoom)) return 1;
  return Math.min(Math.max(zoom, VIEWPORT_MIN_ZOOM), VIEWPORT_MAX_ZOOM);
}

/**
 * crypto.randomUUID() ベースの安定 ID 生成。
 * Issue #157: 旧 `Date.now() + counter` 方式は zustand persist 復元 + リロード後の
 * counter リセットで稀に衝突しうる。Tauri WebView2 / 主要ブラウザでサポート済み。
 * fallback 環境では Math.random ベースで補う。
 */
export function newId(prefix: string): string {
  const u =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${u}`;
}

export interface NormalizedCanvasState {
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
export function normalizeCanvasState(input: unknown): NormalizedCanvasState {
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
    return gap === 'tight' || gap === 'normal' || gap === 'wide'
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
 * persist version → migration 関数 のテーブル。
 *
 * 各 entry は「source version (= fromVersion 直後) からその次の version へ移行する」
 * 時に呼ばれる pure 関数。最後に必ず `normalizeCanvasState` を通すので、各 step は
 * 「自身の責務である構造変換」だけに集中して構わない (型不正 / 範囲外値の保護は
 * normalize が引き受ける)。
 *
 * 新しい persist version を追加するときは:
 *   1. このテーブルに `[N]: (raw) => transformed` を追加
 *   2. `stores/canvas.ts` の `version: N+1` に bump
 *   3. `canvas-migrate.test.ts` に v(N) → v(N+1) のケースを足す
 */
type RawState = Record<string, unknown>;
type StepMigrator = (raw: RawState) => RawState;

const MIGRATION_STEPS: Record<number, StepMigrator> = {
  // v1 → v2: payload.role を payload.roleProfileId にリネーム
  1: (p) => {
    if (!Array.isArray(p.nodes)) return p;
    return {
      ...p,
      nodes: p.nodes.map((n) => {
        if (!isRecord(n)) return n;
        const data = (n.data ?? {}) as Record<string, unknown>;
        const payload = (data.payload ?? {}) as Record<string, unknown>;
        if (typeof payload.role === 'string' && !payload.roleProfileId) {
          payload.roleProfileId = payload.role;
        }
        return { ...n, data: { ...data, payload } };
      })
    };
  },
  // v2 → v3 (Issue #253): 旧 NODE_W/H (480x320) → 640x400。ユーザーが手動拡大した
  // 値は尊重するため <= LEGACY_*_THRESHOLD のときだけ引き上げる。
  2: (p) => {
    if (!Array.isArray(p.nodes)) return p;
    return {
      ...p,
      nodes: p.nodes.map((n) => {
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
      })
    };
  },
  // v3 → v4 (Issue #385): 構造変換は不要 (normalize で吸収する)。
  3: (p) => p
};

/**
 * persist の `migrate` 本体。
 * 入力 persisted state を `fromVersion` から最新 version までテーブル順に進める。
 * 最後に `normalizeCanvasState` で型 / 範囲を最終チェックする。
 */
export function runCanvasMigration(
  persisted: unknown,
  fromVersion: number
): NormalizedCanvasState {
  if (!isRecord(persisted)) {
    return normalizeCanvasState({});
  }
  let cur: RawState = { ...persisted };
  // テーブル順に「fromVersion → fromVersion+1 → … → 現行」と進める。
  // 不存在 step は no-op として扱う (将来 entry 抜けに保険)。
  const steps = Object.keys(MIGRATION_STEPS)
    .map((k) => Number(k))
    .filter((v) => v >= fromVersion)
    .sort((a, b) => a - b);
  for (const v of steps) {
    cur = MIGRATION_STEPS[v](cur);
  }
  return normalizeCanvasState(cur);
}

/**
 * テスト用 export。zustand persist 経由ではなく直接 normalize / 定数を検証するため。
 * 互換性のため `stores/canvas.ts` 経由でも同じオブジェクトを再 export する。
 */
export const __testables = {
  normalizeCanvasState,
  VIEWPORT_MIN_ZOOM,
  VIEWPORT_MAX_ZOOM,
  VIEWPORT_RESCUE_DISTANCE
};

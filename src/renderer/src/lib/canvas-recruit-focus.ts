/**
 * Issue #372: recruit 後に viewport を新規 worker カード中心へ寄せるための
 * 純粋計算関数。Canvas.tsx の useEffect でしか使わないが、ノードサイズが
 * 実測サイズ / style / fallback のどこから来るかが多岐にわたるため pure 化して
 * unit test しやすくする。
 */
import type { Node } from '@xyflow/react';

export interface RecruitFocusInput {
  /** 中心に置きたいノード (見つからなければ null)。 */
  node: Pick<Node, 'position' | 'measured' | 'width' | 'height' | 'style'> | null;
  /** 既存 zoom (= 現在の viewport.zoom)。 */
  currentZoom: number;
  /** ターゲット最小 zoom。`currentZoom` がこれを上回っていればそのまま維持する。 */
  minZoom: number;
  /** ノードサイズ取得に失敗したときの幅 / 高さ (NODE_W / NODE_H 想定)。 */
  fallbackWidth: number;
  fallbackHeight: number;
}

export interface RecruitFocusResult {
  /** viewport 中心 (= reactFlow.setCenter の x). */
  centerX: number;
  /** viewport 中心 (= reactFlow.setCenter の y). */
  centerY: number;
  /** setCenter に渡す zoom (= 現在 zoom と min の max)。 */
  zoom: number;
}

function pickNumber(...candidates: Array<unknown>): number | null {
  for (const v of candidates) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

/**
 * 対象ノードの中心座標と適用すべき zoom を計算する。
 * - `node` が null のときは null を返す (呼び出し側で no-op にする)。
 * - `node.measured` (React Flow が DOM を計測した値) を最優先。
 *   無ければ `node.width` / `node.height` (props 直指定値)、
 *   最後に `node.style.width` / `node.style.height` を見る。
 *   どれも欠けていたら fallback (NODE_W / NODE_H) を使う。
 * - zoom は `max(currentZoom, minZoom)`。手動で寄せた zoom を勝手に縮小しない。
 */
export function computeRecruitFocus(
  input: RecruitFocusInput
): RecruitFocusResult | null {
  const { node, currentZoom, minZoom, fallbackWidth, fallbackHeight } = input;
  if (!node) return null;

  const measured = node.measured ?? null;
  const styleW =
    node.style && typeof (node.style as { width?: unknown }).width === 'number'
      ? ((node.style as { width: number }).width)
      : null;
  const styleH =
    node.style && typeof (node.style as { height?: unknown }).height === 'number'
      ? ((node.style as { height: number }).height)
      : null;

  const width =
    pickNumber(measured?.width, node.width, styleW) ?? fallbackWidth;
  const height =
    pickNumber(measured?.height, node.height, styleH) ?? fallbackHeight;

  const zoom = Math.max(
    currentZoom > 0 && Number.isFinite(currentZoom) ? currentZoom : minZoom,
    minZoom
  );
  return {
    centerX: node.position.x + width / 2,
    centerY: node.position.y + height / 2,
    zoom
  };
}

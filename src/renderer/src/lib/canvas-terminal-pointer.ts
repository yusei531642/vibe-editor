/**
 * Issue #397: Canvas モード (React Flow `transform: scale(zoom)` 配下) の xterm では、
 * pointer 座標が「スケール後の screen px」、cell 幅が「論理 px」として計算されているため、
 * zoom != 1 のときに cell 位置がずれて 4 行ほど上を選択してしまう。
 *
 * 修正方針:
 *   container 矩形 (rect) と zoom を使って、capture phase で受け取った clientX/clientY を
 *   論理座標 (= zoom == 1 と等価な座標系) に変換する。xterm は変換後の座標で正しい cell を
 *   計算できる。
 */

export interface NormalizeInput {
  clientX: number;
  clientY: number;
  /** container (= `.terminal-view`) の `getBoundingClientRect()`。視覚スケール後の値。 */
  rect: { left: number; top: number };
  /** 現在の Canvas zoom (= `getZoom()`)。0 / 非有限 / |zoom - 1| < 0.01 のときは no-op。 */
  zoom: number;
}

export interface NormalizedPoint {
  clientX: number;
  clientY: number;
}

const ZOOM_NEUTRAL_THRESHOLD = 0.01;

/**
 * `clientX/clientY` を論理座標に補正する。
 * - zoom が 0 / 非有限 / |zoom - 1| < 0.01 のときは元の値をそのまま返す (no-op)。
 * - container 矩形からの相対距離 `(clientX - rect.left)` を `1 / zoom` 倍して再構成する。
 */
export function normalizeCanvasTerminalClientPoint(
  input: NormalizeInput
): NormalizedPoint {
  const { clientX, clientY, rect, zoom } = input;
  if (!Number.isFinite(zoom) || zoom <= 0) {
    return { clientX, clientY };
  }
  if (Math.abs(zoom - 1) < ZOOM_NEUTRAL_THRESHOLD) {
    return { clientX, clientY };
  }
  return {
    clientX: rect.left + (clientX - rect.left) / zoom,
    clientY: rect.top + (clientY - rect.top) / zoom
  };
}

export const __testables = { ZOOM_NEUTRAL_THRESHOLD };

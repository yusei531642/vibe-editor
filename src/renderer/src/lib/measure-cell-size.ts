/**
 * xterm の private API (`term._core._renderService.dimensions`) に依存せず、
 * Canvas 2D の `measureText('M')` でセル幅、`fontSize * lineHeight` でセル高を算出する純関数。
 *
 * Issue #253 の核心: React Flow の `transform: scale(zoom)` 下では
 * `getBoundingClientRect()` が transform 適用後の視覚矩形を返すため、PTY の cols/rows が
 * 過小/過大に計算されて Codex/Claude TUI が崩れる。本関数の戻り値は zoom と独立した
 * フォント本来のメトリクスを返すので、`computeUnscaledGrid` と組み合わせれば論理 px 基準で
 * 正しい cols/rows が算出できる。
 *
 * 実機 (Tauri / WebView2) では canvas が利用可能で実測値を返す。jsdom 等で
 * `getContext('2d')` が null になる環境でも、`fontSize * 0.6` (等幅フォントの典型的な
 * アスペクト比) にフォールバックして常に正の有限値を保証する。
 */

const FALLBACK_CELL_W_RATIO = 0.6;
const SAFE_DEFAULT_FONT_SIZE = 13;
const SAFE_DEFAULT_LINE_HEIGHT = 1.0;

/**
 * Issue #253 review (I1): zoom 変化や ResizeObserver 経由で本関数が高頻度に呼ばれるため、
 * 毎回 `document.createElement('canvas')` で HTMLCanvasElement を生成すると不要な
 * allocation/GC が走る。モジュールスコープで 1 個だけキャッシュし、`getContext('2d')` を
 * 同じ canvas に対して呼び続ける。canvas 自体は DOM に追加されない (offscreen) ので
 * テスト環境でも副作用なし。
 */
let cachedMeasureCanvas: HTMLCanvasElement | null = null;

export interface CellSize {
  /** セル 1 個の幅 (CSS px、論理単位) */
  cellW: number;
  /** セル 1 個の高さ (CSS px、論理単位) */
  cellH: number;
  /** Canvas 測定が使えず fallback 値を返したかどうか (可観測性ログ用) */
  fallback: boolean;
}

export function measureCellSize(
  fontSize: number,
  fontFamily: string,
  lineHeight: number = SAFE_DEFAULT_LINE_HEIGHT
): CellSize {
  const safeFontSize =
    Number.isFinite(fontSize) && fontSize > 0 ? fontSize : SAFE_DEFAULT_FONT_SIZE;
  const safeLineHeight =
    Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : SAFE_DEFAULT_LINE_HEIGHT;
  const cellH = safeFontSize * safeLineHeight;

  const fallback: CellSize = {
    cellW: safeFontSize * FALLBACK_CELL_W_RATIO,
    cellH,
    fallback: true
  };

  if (typeof document === 'undefined') return fallback;

  try {
    const canvas = cachedMeasureCanvas ?? (cachedMeasureCanvas = document.createElement('canvas'));
    const ctx = canvas.getContext('2d');
    if (!ctx) return fallback;
    const family = fontFamily.trim() || 'monospace';
    ctx.font = `${safeFontSize}px ${family}`;
    const metrics = ctx.measureText('M');
    if (!metrics || !Number.isFinite(metrics.width) || metrics.width <= 0) {
      return fallback;
    }
    return { cellW: metrics.width, cellH, fallback: false };
  } catch {
    return fallback;
  }
}

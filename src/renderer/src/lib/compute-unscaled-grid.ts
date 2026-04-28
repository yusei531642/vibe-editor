/**
 * コンテナの論理 px サイズとセルメトリクスから PTY に渡す cols/rows を算出する純関数。
 *
 * Issue #253 の核心: React Flow の `transform: scale(zoom)` 下では
 * `getBoundingClientRect()` が transform 適用後の視覚矩形を返すため、cols/rows が zoom で
 * 過小/過大に揺れる。本関数は呼び出し側に「transform 非適用の論理 px (`clientWidth` /
 * `clientHeight`)」を渡してもらうことで、zoom と独立した PTY 寸法を返す。
 *
 * 不正入力 (0 / 負値 / NaN / Infinity) では `null` を返す。Tauri IPC 経由で 0 cols/rows が
 * PTY に渡ると xterm がクラッシュ気味の挙動を見せるため、呼び出し側に明示的な null チェック
 * を強制する設計。
 *
 * clamp 順序は `Math.min(max, Math.max(min, raw))` で max を絶対上限にする。`min > max` の
 * 異常入力では max が勝つ (安全側)。
 */

export interface GridOptions {
  /** 最小列数 (default: 20)。これより小さい raw 値はクランプして引き上げる */
  minCols?: number;
  /** 最小行数 (default: 5) */
  minRows?: number;
  /** 最大列数 (default: 500)。tmux/xterm の現実的上限を考慮 */
  maxCols?: number;
  /** 最大行数 (default: 200) */
  maxRows?: number;
}

const DEFAULT_MIN_COLS = 20;
const DEFAULT_MIN_ROWS = 5;
const DEFAULT_MAX_COLS = 500;
const DEFAULT_MAX_ROWS = 200;

function isPositiveFinite(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

export function computeUnscaledGrid(
  width: number,
  height: number,
  cellW: number,
  cellH: number,
  options: GridOptions = {}
): { cols: number; rows: number } | null {
  if (!isPositiveFinite(width) || !isPositiveFinite(height)) return null;
  if (!isPositiveFinite(cellW) || !isPositiveFinite(cellH)) return null;

  const {
    minCols = DEFAULT_MIN_COLS,
    minRows = DEFAULT_MIN_ROWS,
    maxCols = DEFAULT_MAX_COLS,
    maxRows = DEFAULT_MAX_ROWS
  } = options;

  // Issue #261: rows は Math.round で端数行を救済する。
  //
  // 旧実装は `Math.floor(height / cellH)` で常に余り (height - rows*cellH) が下端に
  // 透明スペースとして残り、Canvas モードでは「最後の行が見えない」体感に直結していた
  // (lineHeight=1.0 + cellH=13 で最大 12px、ほぼ 1 行ぶん欠ける)。round に変えると
  // 端数が 0.5 行以上のときに +1 行され、xterm 内部 viewport が容器より僅かに高く
  // なってもキャンバスモード側 CSS で `.xterm-viewport { overflow-y: auto }` を許可
  // しているため scrollbar で確実に末尾まで到達できる。
  // cols は折り返し挙動への影響を避けるため従来どおり floor。
  const rawCols = Math.floor(width / cellW);
  const rawRows = Math.round(height / cellH);

  return {
    cols: Math.min(maxCols, Math.max(minCols, rawCols)),
    rows: Math.min(maxRows, Math.max(minRows, rawRows))
  };
}

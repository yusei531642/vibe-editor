/**
 * xterm.js v5/v6 の内部レンダラから実 cell サイズ (px) を取得する純関数。
 *
 * Issue #272: `measureCellSize()` の `cellH = fontSize * lineHeight` は xterm v6
 * `CharSizeService` の `measureText('W') + fontBoundingBoxAscent + Descent` と
 * ずれており、`useFitToContainer` の rows fit が xterm 内部 rows と不一致。結果
 * `.xterm-screen.style.height = rows * cellH` の固定 px がカード高さと合わず下半分が
 * 黒く残る／最終行が見切れる。本関数は xterm 自身が保持する実 cell px を読み取り、
 * Canvas モード fit の rows 算出基準を renderer 実寸に揃える。
 *
 * private API への依存:
 *   `(term as any)._core._renderService.dimensions.css.cell.{width,height}`
 *   xterm v5/v6 のソース (`@xterm/xterm/src/browser/CoreBrowserTerminal.ts`,
 *   `src/browser/renderer/shared/Types.ts`, `src/browser/services/CharSizeService.ts`)
 *   で確認済み。renderer がまだ初期化されていない (mount 直後等) は null を返す。
 *
 * 取得失敗時は呼出側 (`useFitToContainer`) が `getCellSize()` (Canvas 2D measureText
 * ベース) にフォールバックする。
 */
import type { Terminal } from '@xterm/xterm';

export interface XtermRuntimeCellSize {
  cellW: number;
  cellH: number;
}

// xterm v5/v6 の主要パスを優先順で並べる。先頭が現行 v6、後ろは将来/旧版/test double 互換。
const RUNTIME_CELL_PATHS = [
  ['_core', '_renderService', 'dimensions', 'css', 'cell'],
  ['_renderService', 'dimensions', 'css', 'cell'],
  ['_core', 'renderService', 'dimensions', 'css', 'cell'],
  ['renderService', 'dimensions', 'css', 'cell'],
  ['_core', '_core', '_renderService', 'dimensions', 'css', 'cell']
] as const;

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function readPath(root: unknown, path: readonly string[]): unknown {
  try {
    let value: unknown = root;
    for (const key of path) {
      if (!value || typeof value !== 'object') return null;
      value = (value as Record<string, unknown>)[key];
    }
    return value;
  } catch {
    return null;
  }
}

function toRuntimeCellSize(value: unknown): XtermRuntimeCellSize | null {
  if (!value || typeof value !== 'object') return null;
  const cell = value as Record<string, unknown>;
  const width = cell.width;
  const height = cell.height;

  if (!isPositiveFiniteNumber(width) || !isPositiveFiniteNumber(height)) {
    return null;
  }

  return { cellW: width, cellH: height };
}

export function getXtermRuntimeCellSize(term: Terminal | null): XtermRuntimeCellSize | null {
  if (!term) return null;

  try {
    for (const path of RUNTIME_CELL_PATHS) {
      const cell = toRuntimeCellSize(readPath(term, path));
      if (cell) return cell;
    }
  } catch {
    return null;
  }

  return null;
}

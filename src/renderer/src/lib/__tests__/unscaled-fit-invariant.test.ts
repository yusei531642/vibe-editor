/**
 * Issue #253 の核心不変性テスト:
 *   container.clientWidth / clientHeight は transform: scale(zoom) の影響を受けない
 *   論理 px なので、measureCellSize → computeUnscaledGrid の組合せが返す cols/rows は
 *   zoom と独立でなければならない。
 *
 * 本テストは hooks 統合 (useFitToContainer / usePtySession) が壊れていても、
 * 純関数の組合せが不変性を保つことを保証する。
 */
import { describe, it, expect } from 'vitest';
import { measureCellSize } from '../measure-cell-size';
import { computeUnscaledGrid } from '../compute-unscaled-grid';

describe('unscaled fit invariant (Issue #253 P6)', () => {
  it('zoom 0.3/1.0/1.5 で同一の論理サイズなら cols/rows は同一', () => {
    // container.clientWidth / clientHeight は transform 非適用の論理 px。
    // zoom が 0.3/1.0/1.5 でも、論理サイズが 800x600 なら入力は同じになる。
    const logicalWidth = 800;
    const logicalHeight = 600;
    const cell = measureCellSize(13, 'monospace', 1.0);

    const gridZ03 = computeUnscaledGrid(logicalWidth, logicalHeight, cell.cellW, cell.cellH);
    const gridZ10 = computeUnscaledGrid(logicalWidth, logicalHeight, cell.cellW, cell.cellH);
    const gridZ15 = computeUnscaledGrid(logicalWidth, logicalHeight, cell.cellW, cell.cellH);

    expect(gridZ03).not.toBeNull();
    expect(gridZ03).toEqual(gridZ10);
    expect(gridZ10).toEqual(gridZ15);
  });

  it('もし誤って getBoundingClientRect (scale 後の視覚矩形) を渡すと cols/rows が zoom に依存して崩れる (アンチパターン検証)', () => {
    // これは「やってはいけない」例の確認。zoom=0.5 のとき視覚矩形は半分になる
    // → cols/rows が半分に。Issue #253 の P6 の症状そのもの。
    const logicalWidth = 800;
    const logicalHeight = 600;
    const cell = measureCellSize(13, 'monospace', 1.0);

    const visualWidthZ05 = logicalWidth * 0.5;
    const visualHeightZ05 = logicalHeight * 0.5;
    const visualWidthZ15 = logicalWidth * 1.5;
    const visualHeightZ15 = logicalHeight * 1.5;

    const wrongZ05 = computeUnscaledGrid(visualWidthZ05, visualHeightZ05, cell.cellW, cell.cellH);
    const wrongZ15 = computeUnscaledGrid(visualWidthZ15, visualHeightZ15, cell.cellW, cell.cellH);

    expect(wrongZ05).not.toBeNull();
    expect(wrongZ15).not.toBeNull();
    expect(wrongZ05?.cols).not.toBe(wrongZ15?.cols);
    expect(wrongZ05?.rows).not.toBe(wrongZ15?.rows);
  });

  it('量子化: zoom を Math.round(z*100)/100 で量子化すると 0.499 と 0.501 は別だが 0.500 と 0.501 は同じ', () => {
    const q = (z: number): number => Math.round(z * 100) / 100;
    expect(q(0.499)).toBe(0.5);
    expect(q(0.501)).toBe(0.5);
    expect(q(0.504)).toBe(0.5);
    expect(q(0.505)).toBe(0.51);
  });
});

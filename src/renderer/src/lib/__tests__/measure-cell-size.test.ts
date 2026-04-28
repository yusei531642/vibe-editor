import { describe, it, expect } from 'vitest';
import { measureCellSize } from '../measure-cell-size';

describe('measureCellSize', () => {
  it('cellH = fontSize * lineHeight (lineHeight=1.0)', () => {
    const r = measureCellSize(13, 'monospace', 1.0);
    expect(r.cellH).toBe(13);
  });

  it('cellH = fontSize * lineHeight (lineHeight=1.5)', () => {
    const r = measureCellSize(16, 'monospace', 1.5);
    expect(r.cellH).toBe(24);
  });

  it('lineHeight 省略時はデフォルト 1.0 が適用される', () => {
    const r = measureCellSize(20, 'monospace');
    expect(r.cellH).toBe(20);
  });

  it('cellW は常に正の数を返す', () => {
    const r = measureCellSize(13, 'monospace');
    expect(r.cellW).toBeGreaterThan(0);
    expect(Number.isFinite(r.cellW)).toBe(true);
  });

  it('fontSize=0 でも安全にフォールバック値を返す', () => {
    const r = measureCellSize(0, 'monospace');
    expect(r.cellH).toBeGreaterThan(0);
    expect(r.cellW).toBeGreaterThan(0);
  });

  it('fontSize 負値でも安全にフォールバック値を返す', () => {
    const r = measureCellSize(-10, 'monospace');
    expect(r.cellH).toBeGreaterThan(0);
    expect(r.cellW).toBeGreaterThan(0);
  });

  it('lineHeight=0 でも安全 (lineHeight=1.0 にフォールバック)', () => {
    const r = measureCellSize(13, 'monospace', 0);
    expect(r.cellH).toBeGreaterThan(0);
  });

  it('fallback フィールドは boolean', () => {
    const r = measureCellSize(13, 'monospace');
    expect(typeof r.fallback).toBe('boolean');
  });

  it('fontFamily が空文字でも例外を投げない', () => {
    expect(() => measureCellSize(13, '')).not.toThrow();
    const r = measureCellSize(13, '');
    expect(r.cellW).toBeGreaterThan(0);
  });

  it('実用的な値域: fontSize=13 で cellW は 4..15 px の範囲に収まる (等幅 fontの典型)', () => {
    const r = measureCellSize(13, 'monospace');
    expect(r.cellW).toBeGreaterThanOrEqual(4);
    expect(r.cellW).toBeLessThanOrEqual(15);
  });
});

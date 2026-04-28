import { describe, it, expect } from 'vitest';
import { computeUnscaledGrid } from '../compute-unscaled-grid';

describe('computeUnscaledGrid', () => {
  describe('通常値', () => {
    it('800x600 / cellW=8 / cellH=16 → cols=100 rows=38', () => {
      // Issue #261: rows は Math.round 化したため、600 / 16 = 37.5 → 38 (upper round)。
      // cols は折り返し回避のため依然 floor で 800 / 8 = 100。
      const r = computeUnscaledGrid(800, 600, 8, 16);
      expect(r).toEqual({ cols: 100, rows: 38 });
    });

    it('cols は Math.floor で切り捨てる (800.7 / 8 = 100.0875 → 100)', () => {
      // Issue #261: rows は round 化したが、cols は折り返し回避のため floor のまま。
      // 600.5 / 16 = 37.53125 → round で 38 行になる。
      const r = computeUnscaledGrid(800.7, 600.5, 8, 16);
      expect(r).toEqual({ cols: 100, rows: 38 });
    });
  });

  describe('Issue #261: rows は Math.round で端数行を救済する', () => {
    // lineHeight=1.0 + terminalFontSize=13 を想定 (cellH=13)。
    // 旧実装は floor だったため、端数 1〜12px が常に下端の透明スペースとして残り、
    // Canvas モードで「最後の行が見えない」体感に繋がっていた。
    it('端数 < 0.5 行 → 切り捨て (height=275 / cellH=13 → 21.15 → 21)', () => {
      const r = computeUnscaledGrid(800, 275, 8, 13);
      expect(r?.rows).toBe(21);
    });

    it('端数 = 0.5 行ジャスト → 繰り上げ (height=286 / cellH=13 → 22.0 → 22, height=279.5/13≈21.5 → 22)', () => {
      // 286 / 13 = 22.0 (端数なし)
      const r1 = computeUnscaledGrid(800, 286, 8, 13);
      expect(r1?.rows).toBe(22);
      // 279.5 / 13 = 21.5 (ちょうど 0.5)
      const r2 = computeUnscaledGrid(800, 279.5, 8, 13);
      expect(r2?.rows).toBe(22);
    });

    it('端数 >= 0.5 行 → 繰り上げ (height=287 / cellH=13 → 22.08 → 22)', () => {
      const r = computeUnscaledGrid(800, 287, 8, 13);
      expect(r?.rows).toBe(22);
    });

    it('小数 cellH でも整数 rows を返す (height=280 / cellH=13.5 → 20.74 → 21)', () => {
      const r = computeUnscaledGrid(800, 280, 8, 13.5);
      expect(r?.rows).toBe(21);
      expect(Number.isInteger(r?.rows)).toBe(true);
    });

    it('round 後も clamp は効く: 端数で minRows 未満になっても下限保証', () => {
      // 60 / 13 = 4.61 → round = 5 (デフォルト minRows=5 と同値)
      const r = computeUnscaledGrid(800, 60, 8, 13);
      expect(r?.rows).toBe(5);
    });

    it('round 後も maxRows clamp が効く', () => {
      // 100000 / 13 = 7692 → maxRows=200 にクランプ
      const r = computeUnscaledGrid(800, 100000, 8, 13);
      expect(r?.rows).toBe(200);
    });
  });

  describe('null を返す不正入力 (ゼロ除算ガード)', () => {
    it('width=0 → null', () => {
      expect(computeUnscaledGrid(0, 600, 8, 16)).toBeNull();
    });
    it('height=0 → null', () => {
      expect(computeUnscaledGrid(800, 0, 8, 16)).toBeNull();
    });
    it('cellW=0 → null', () => {
      expect(computeUnscaledGrid(800, 600, 0, 16)).toBeNull();
    });
    it('cellH=0 → null', () => {
      expect(computeUnscaledGrid(800, 600, 8, 0)).toBeNull();
    });
    it('width 負値 → null', () => {
      expect(computeUnscaledGrid(-100, 600, 8, 16)).toBeNull();
    });
    it('cellW 負値 → null', () => {
      expect(computeUnscaledGrid(800, 600, -8, 16)).toBeNull();
    });
    it('NaN → null', () => {
      expect(computeUnscaledGrid(NaN, 600, 8, 16)).toBeNull();
      expect(computeUnscaledGrid(800, 600, NaN, 16)).toBeNull();
    });
    it('Infinity → null', () => {
      expect(computeUnscaledGrid(Infinity, 600, 8, 16)).toBeNull();
      expect(computeUnscaledGrid(800, 600, 8, Infinity)).toBeNull();
    });
  });

  describe('デフォルト clamp (min=20/5, max=500/200)', () => {
    it('過小: width=10 / cellW=8 → rawCols=1 → minCols=20 にクランプ', () => {
      const r = computeUnscaledGrid(10, 600, 8, 16);
      expect(r?.cols).toBe(20);
    });

    it('過小: height=10 / cellH=16 → rawRows=0 → minRows=5 にクランプ', () => {
      const r = computeUnscaledGrid(800, 10, 8, 16);
      expect(r?.rows).toBe(5);
    });

    it('過大: width=10000 / cellW=8 → rawCols=1250 → maxCols=500 にクランプ', () => {
      const r = computeUnscaledGrid(10000, 600, 8, 16);
      expect(r?.cols).toBe(500);
    });

    it('過大: height=10000 / cellH=16 → rawRows=625 → maxRows=200 にクランプ', () => {
      const r = computeUnscaledGrid(800, 10000, 8, 16);
      expect(r?.rows).toBe(200);
    });
  });

  describe('options カスタム指定', () => {
    it('minCols=10 を指定すると 10 までクランプ可能', () => {
      const r = computeUnscaledGrid(50, 600, 8, 16, { minCols: 10 });
      expect(r?.cols).toBe(10);
    });

    it('maxCols=80 を指定すると 80 で頭打ち', () => {
      const r = computeUnscaledGrid(10000, 600, 8, 16, { maxCols: 80 });
      expect(r?.cols).toBe(80);
    });

    it('部分指定 (minCols のみ) でも他はデフォルト', () => {
      const r = computeUnscaledGrid(10000, 10000, 8, 16, { minCols: 10 });
      expect(r?.cols).toBe(500);
      expect(r?.rows).toBe(200);
    });

    it('min > max の異常入力では max が優先される (安全側)', () => {
      const r = computeUnscaledGrid(800, 600, 8, 16, { minCols: 1000, maxCols: 50 });
      expect(r?.cols).toBe(50);
    });
  });

  describe('整数性', () => {
    it('cols/rows は常に整数', () => {
      const r = computeUnscaledGrid(817.3, 599.9, 7.9, 15.7);
      expect(Number.isInteger(r?.cols)).toBe(true);
      expect(Number.isInteger(r?.rows)).toBe(true);
    });
  });
});

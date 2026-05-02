import { describe, expect, it } from 'vitest';
import { normalizeCanvasTerminalClientPoint } from '../canvas-terminal-pointer';

const rect = { left: 100, top: 200 };

describe('normalizeCanvasTerminalClientPoint', () => {
  it('zoom = 1 のときは元の値をそのまま返す', () => {
    const out = normalizeCanvasTerminalClientPoint({
      clientX: 250,
      clientY: 380,
      rect,
      zoom: 1
    });
    expect(out).toEqual({ clientX: 250, clientY: 380 });
  });

  it('|zoom - 1| < 0.01 では no-op', () => {
    const out = normalizeCanvasTerminalClientPoint({
      clientX: 250,
      clientY: 380,
      rect,
      zoom: 1.005
    });
    expect(out).toEqual({ clientX: 250, clientY: 380 });
  });

  it('zoom = 0.7 で container 内側の点を論理座標へ展開する', () => {
    const out = normalizeCanvasTerminalClientPoint({
      clientX: 100 + 70, // rect.left + 70 (visual px)
      clientY: 200 + 35, // rect.top + 35 (visual px)
      rect,
      zoom: 0.7
    });
    // 論理 = rect + (visual / zoom)
    expect(out.clientX).toBeCloseTo(100 + 70 / 0.7, 6); // = 200
    expect(out.clientY).toBeCloseTo(200 + 35 / 0.7, 6); // = 250
  });

  it('zoom = 1.5 で container 内側の点を縮める', () => {
    const out = normalizeCanvasTerminalClientPoint({
      clientX: 100 + 150,
      clientY: 200 + 75,
      rect,
      zoom: 1.5
    });
    expect(out.clientX).toBeCloseTo(100 + 150 / 1.5, 6); // = 200
    expect(out.clientY).toBeCloseTo(200 + 75 / 1.5, 6); // = 250
  });

  it('zoom = 0 / NaN / 負値は no-op (異常値ガード)', () => {
    for (const zoom of [0, -1, NaN, Number.POSITIVE_INFINITY]) {
      const out = normalizeCanvasTerminalClientPoint({
        clientX: 250,
        clientY: 380,
        rect,
        zoom
      });
      expect(out).toEqual({ clientX: 250, clientY: 380 });
    }
  });

  it('rect.left/top が 0 でも線形に正しく動く', () => {
    const out = normalizeCanvasTerminalClientPoint({
      clientX: 700,
      clientY: 350,
      rect: { left: 0, top: 0 },
      zoom: 0.5
    });
    expect(out.clientX).toBeCloseTo(1400, 6);
    expect(out.clientY).toBeCloseTo(700, 6);
  });
});

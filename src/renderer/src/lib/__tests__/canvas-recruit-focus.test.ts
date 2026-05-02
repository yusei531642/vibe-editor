import { describe, expect, it } from 'vitest';
import { computeRecruitFocus } from '../canvas-recruit-focus';

const NODE_W = 640;
const NODE_H = 400;

describe('computeRecruitFocus', () => {
  it('node が null なら null を返す (no-op)', () => {
    expect(
      computeRecruitFocus({
        node: null,
        currentZoom: 1,
        minZoom: 0.7,
        fallbackWidth: NODE_W,
        fallbackHeight: NODE_H
      })
    ).toBeNull();
  });

  it('measured を最優先して中心を計算する', () => {
    const result = computeRecruitFocus({
      node: {
        position: { x: 100, y: 200 },
        measured: { width: 400, height: 300 },
        style: { width: NODE_W, height: NODE_H }
      } as never,
      currentZoom: 1,
      minZoom: 0.7,
      fallbackWidth: NODE_W,
      fallbackHeight: NODE_H
    });
    expect(result).toEqual({
      centerX: 100 + 400 / 2,
      centerY: 200 + 300 / 2,
      zoom: 1
    });
  });

  it('measured 不在なら style の width/height を使う', () => {
    const result = computeRecruitFocus({
      node: {
        position: { x: 0, y: 0 },
        style: { width: 800, height: 600 }
      } as never,
      currentZoom: 0.9,
      minZoom: 0.7,
      fallbackWidth: NODE_W,
      fallbackHeight: NODE_H
    });
    expect(result).toEqual({ centerX: 400, centerY: 300, zoom: 0.9 });
  });

  it('measured / style / props ともに無ければ fallback サイズで中心を計算する', () => {
    const result = computeRecruitFocus({
      node: {
        position: { x: 1000, y: 2000 }
      } as never,
      currentZoom: 1,
      minZoom: 0.7,
      fallbackWidth: NODE_W,
      fallbackHeight: NODE_H
    });
    expect(result).toEqual({
      centerX: 1000 + NODE_W / 2,
      centerY: 2000 + NODE_H / 2,
      zoom: 1
    });
  });

  it('現在 zoom が minZoom 未満でも minZoom にクランプされる', () => {
    const result = computeRecruitFocus({
      node: { position: { x: 0, y: 0 } } as never,
      currentZoom: 0.3,
      minZoom: 0.7,
      fallbackWidth: NODE_W,
      fallbackHeight: NODE_H
    });
    expect(result?.zoom).toBe(0.7);
  });

  it('現在 zoom が minZoom 以上ならそのまま使う (拡大は維持)', () => {
    const result = computeRecruitFocus({
      node: { position: { x: 0, y: 0 } } as never,
      currentZoom: 1.4,
      minZoom: 0.7,
      fallbackWidth: NODE_W,
      fallbackHeight: NODE_H
    });
    expect(result?.zoom).toBe(1.4);
  });

  it('measured / style に不正値 (0 / NaN) が混じっても fallback に逃げる', () => {
    const result = computeRecruitFocus({
      node: {
        position: { x: 50, y: 60 },
        measured: { width: NaN, height: 0 },
        style: { width: 0, height: NaN }
      } as never,
      currentZoom: 1,
      minZoom: 0.7,
      fallbackWidth: NODE_W,
      fallbackHeight: NODE_H
    });
    expect(result).toEqual({
      centerX: 50 + NODE_W / 2,
      centerY: 60 + NODE_H / 2,
      zoom: 1
    });
  });
});

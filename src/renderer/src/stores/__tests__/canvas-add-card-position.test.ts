import { beforeEach, describe, expect, it } from 'vitest';
import { NODE_H, NODE_W, useCanvasStore } from '../canvas';
import { nextFallbackCardPosition } from '../canvas-card-identity';

const GAP = 32;

describe('useCanvasStore.addCard fallback placement (Issue #840)', () => {
  beforeEach(() => {
    if (typeof localStorage !== 'undefined') localStorage.clear();
    useCanvasStore.getState().clear();
  });

  it('カード削除後も position 省略の addCard が既存カードと座標が重複しない', () => {
    const store = useCanvasStore.getState();
    const ids = Array.from({ length: 7 }, (_, index) =>
      store.addCard({
        type: 'terminal',
        title: `Terminal ${index + 1}`,
        payload: undefined
      })
    );

    store.removeCard(ids[2], { cascadeTeam: false });

    const nextId = store.addCard({
      type: 'terminal',
      title: 'Terminal next',
      payload: undefined
    });

    const nodes = useCanvasStore.getState().nodes;
    const next = nodes.find((node) => node.id === nextId);
    expect(next?.position).toEqual({ x: (NODE_W + GAP) * 2, y: 0 });

    const positions = nodes.map((node) => `${node.position.x},${node.position.y}`);
    expect(new Set(positions).size).toBe(positions.length);
  });

  it('position が明示された addCard は指定座標をそのまま使う', () => {
    const explicit = { x: NODE_W + GAP, y: NODE_H + GAP };
    const id = useCanvasStore.getState().addCard({
      type: 'terminal',
      title: 'Explicit',
      payload: undefined,
      position: explicit
    });

    expect(useCanvasStore.getState().nodes.find((node) => node.id === id)?.position).toEqual(
      explicit
    );
  });

  it('削除後の明示position経路も共通空きスロット探索なら重複しない (#1141)', () => {
    const store = useCanvasStore.getState();
    const ids = Array.from({ length: 3 }, (_, index) =>
      store.addCard({
        type: 'terminal',
        title: `Terminal ${index + 1}`,
        payload: undefined,
        position: nextFallbackCardPosition(useCanvasStore.getState().nodes)
      })
    );
    store.removeCard(ids[1], { cascadeTeam: false });

    const nextPosition = nextFallbackCardPosition(useCanvasStore.getState().nodes);
    const nextId = store.addCard({
      type: 'terminal',
      title: 'Terminal next',
      payload: undefined,
      position: nextPosition
    });

    expect(useCanvasStore.getState().nodes.find((node) => node.id === nextId)?.position).toEqual({
      x: NODE_W + GAP,
      y: 0
    });
    const positions = useCanvasStore.getState().nodes.map(
      (node) => `${node.position.x},${node.position.y}`
    );
    expect(new Set(positions).size).toBe(positions.length);
  });
});

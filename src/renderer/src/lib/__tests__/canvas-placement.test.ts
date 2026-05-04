import { describe, expect, it } from 'vitest';
import {
  placeBatchAwayFromNodes,
  type BatchPlacementItem,
  type CanvasPlacementNode
} from '../canvas-placement';
import { NODE_H, NODE_W } from '../../stores/canvas';
import { GAP, presetPosition } from '../workspace-presets';

const node = (
  x: number,
  y: number,
  style?: CanvasPlacementNode['style']
): CanvasPlacementNode => ({
  position: { x, y },
  style
});

const item = (x: number, y: number): BatchPlacementItem => ({
  position: { x, y }
});

describe('canvas placement', () => {
  it('moves a leader-only team spawn to the right of an existing card', () => {
    const placed = placeBatchAwayFromNodes([node(0, 0)], [item(0, 0)], { gap: GAP });

    expect(placed[0].position).toEqual({ x: NODE_W + GAP, y: 0 });
  });

  it('keeps batch-relative preset spacing when shifting multiple members', () => {
    const existing = [node(0, 0), node(NODE_W + GAP, 0)];
    const batch = [item(0, 0), item(NODE_W + GAP, 0)];
    const placed = placeBatchAwayFromNodes(existing, batch, { gap: GAP });

    expect(placed[0].position).toEqual({ x: (NODE_W + GAP) * 2, y: 0 });
    expect(placed[1].position.x - placed[0].position.x).toBe(NODE_W + GAP);
    expect(placed[1].position.y).toBe(placed[0].position.y);
  });

  it('does not move a batch that already avoids existing cards', () => {
    const batch = [item(0, 0), item(NODE_W + GAP, 0)];
    const placed = placeBatchAwayFromNodes([node(5000, 0)], batch, { gap: GAP });

    expect(placed.map((card) => card.position)).toEqual(batch.map((card) => card.position));
  });

  it('uses existing node style dimensions for overlap checks', () => {
    const placed = placeBatchAwayFromNodes(
      [node(0, 0, { width: '800px', height: 500 })],
      [item(NODE_W + GAP, 0)],
      { gap: GAP }
    );

    expect(placed[0].position).toEqual({ x: 800 + GAP, y: 0 });
  });

  it('keeps presetPosition output usable as a relative batch layout', () => {
    const batch = [presetPosition(0, 0), presetPosition(1, 0)].map((position) => ({
      position
    }));
    const placed = placeBatchAwayFromNodes([node(0, 0)], batch, { gap: GAP });

    expect(placed[1].position.x - placed[0].position.x).toBe(NODE_W + GAP);
    expect(placed[1].position.y - placed[0].position.y).toBe(0);
  });
});

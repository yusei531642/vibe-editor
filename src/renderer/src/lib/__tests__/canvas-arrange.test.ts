import { describe, it, expect } from 'vitest';
import type { Node } from '@xyflow/react';
import {
  ARRANGE_GAP_PX,
  computeColumns,
  isTerminalLike,
  tidyTerminals,
  unifyTerminalSize
} from '../canvas-arrange';
import { NODE_W, NODE_H, type CardData, type CardType } from '../../stores/canvas';

function makeNode(
  id: string,
  type: CardType,
  position: { x: number; y: number },
  size?: { width?: number; height?: number }
): Node<CardData> {
  return {
    id,
    type,
    position,
    data: { cardType: type, title: id, payload: { kept: true } },
    style: {
      width: size?.width ?? NODE_W,
      height: size?.height ?? NODE_H
    }
  };
}

describe('canvas-arrange / isTerminalLike', () => {
  it('matches terminal and agent only', () => {
    expect(isTerminalLike(makeNode('a', 'terminal', { x: 0, y: 0 }))).toBe(true);
    expect(isTerminalLike(makeNode('b', 'agent', { x: 0, y: 0 }))).toBe(true);
    expect(isTerminalLike(makeNode('c', 'editor', { x: 0, y: 0 }))).toBe(false);
    expect(isTerminalLike(makeNode('d', 'diff', { x: 0, y: 0 }))).toBe(false);
    expect(isTerminalLike(makeNode('e', 'fileTree', { x: 0, y: 0 }))).toBe(false);
    expect(isTerminalLike(makeNode('f', 'changes', { x: 0, y: 0 }))).toBe(false);
  });
});

describe('canvas-arrange / computeColumns', () => {
  it('uses ceil(sqrt(n)) but never less than 1', () => {
    expect(computeColumns(0)).toBe(1);
    expect(computeColumns(1)).toBe(1);
    expect(computeColumns(2)).toBe(2);
    expect(computeColumns(4)).toBe(2);
    expect(computeColumns(5)).toBe(3);
    expect(computeColumns(9)).toBe(3);
    expect(computeColumns(10)).toBe(4);
  });
});

describe('canvas-arrange / tidyTerminals', () => {
  it('grids only terminal-like nodes; leaves others untouched', () => {
    const nodes: Node<CardData>[] = [
      makeNode('t1', 'terminal', { x: 100, y: 200 }, { width: 500, height: 350 }),
      makeNode('t2', 'agent', { x: 900, y: 200 }, { width: 700, height: 420 }),
      makeNode('t3', 'terminal', { x: 100, y: 800 }, { width: 480, height: 280 }),
      makeNode('e1', 'editor', { x: 50, y: 50 }, { width: 800, height: 600 }),
      makeNode('f1', 'fileTree', { x: 5000, y: 5000 }, { width: 320, height: 600 })
    ];

    const out = tidyTerminals(nodes, { gap: 'normal' });
    const gap = ARRANGE_GAP_PX.normal;

    // editor / fileTree は触らない
    const e1 = out.find((n) => n.id === 'e1');
    const f1 = out.find((n) => n.id === 'f1');
    expect(e1).toEqual(nodes.find((n) => n.id === 'e1'));
    expect(f1).toEqual(nodes.find((n) => n.id === 'f1'));

    // terminal-like のサイズが NODE_W/H に揃う
    const targets = out.filter((n) => n.type === 'terminal' || n.type === 'agent');
    for (const n of targets) {
      expect(n.style?.width).toBe(NODE_W);
      expect(n.style?.height).toBe(NODE_H);
    }

    // 起点は元 terminal-like の最小 (x=100, y=200)
    const cols = computeColumns(targets.length); // 3 件 → 2 列
    expect(cols).toBe(2);
    const positions = targets.map((n) => n.position).sort((a, b) => a.y - b.y || a.x - b.x);
    expect(positions[0]).toEqual({ x: 100, y: 200 });
    expect(positions[1]).toEqual({ x: 100 + NODE_W + gap, y: 200 });
    expect(positions[2]).toEqual({ x: 100, y: 200 + NODE_H + gap });
  });

  it('preserves node id, data, payload (no PTY restart risk)', () => {
    const nodes: Node<CardData>[] = [
      makeNode('keep-id', 'terminal', { x: 0, y: 0 })
    ];
    nodes[0].data.payload = { sessionId: 'sess-xyz', teamId: 'team-1' };

    const out = tidyTerminals(nodes);
    expect(out[0].id).toBe('keep-id');
    expect(out[0].data.title).toBe('keep-id');
    expect(out[0].data.payload).toEqual({ sessionId: 'sess-xyz', teamId: 'team-1' });
  });

  it('honors gap option (tight / wide)', () => {
    const nodes: Node<CardData>[] = [
      makeNode('a', 'terminal', { x: 0, y: 0 }),
      makeNode('b', 'terminal', { x: 9999, y: 0 })
    ];
    const tight = tidyTerminals(nodes, { gap: 'tight' });
    const wide = tidyTerminals(nodes, { gap: 'wide' });
    const tightDx = tight[1].position.x - tight[0].position.x;
    const wideDx = wide[1].position.x - wide[0].position.x;
    expect(tightDx).toBe(NODE_W + ARRANGE_GAP_PX.tight);
    expect(wideDx).toBe(NODE_W + ARRANGE_GAP_PX.wide);
  });

  it('returns the input untouched when there are no terminal-like nodes', () => {
    const nodes: Node<CardData>[] = [
      makeNode('e1', 'editor', { x: 10, y: 10 }),
      makeNode('f1', 'fileTree', { x: 20, y: 20 })
    ];
    const out = tidyTerminals(nodes);
    expect(out).toBe(nodes);
  });

  // Issue #442: 整頓後に terminal-like カードが矩形上で重ならないこと。
  // 隣接セル間の dx は (width + gap) >= NODE_W、dy は (height + gap) >= NODE_H を満たす。
  it('places terminal-like cards without overlap (Issue #442 regression)', () => {
    const nodes: Node<CardData>[] = [
      makeNode('t1', 'terminal', { x: 0, y: 0 }),
      makeNode('t2', 'terminal', { x: 50, y: 0 }),
      makeNode('t3', 'terminal', { x: 0, y: 50 }),
      makeNode('t4', 'terminal', { x: 50, y: 50 })
    ];
    const out = tidyTerminals(nodes, { gap: 'normal' });
    const positions = out.map((n) => n.position).sort((a, b) => a.y - b.y || a.x - b.x);
    expect(positions[1].x - positions[0].x).toBeGreaterThanOrEqual(NODE_W);
    expect(positions[2].y - positions[0].y).toBeGreaterThanOrEqual(NODE_H);
    // gap=normal は 32 なので厳密に NODE_W+32, NODE_H+32 と一致するはず
    expect(positions[1].x - positions[0].x).toBe(NODE_W + ARRANGE_GAP_PX.normal);
    expect(positions[2].y - positions[0].y).toBe(NODE_H + ARRANGE_GAP_PX.normal);
  });
});

describe('canvas-arrange / unifyTerminalSize', () => {
  it('only touches sizes; positions are kept', () => {
    const nodes: Node<CardData>[] = [
      makeNode('t1', 'terminal', { x: 100, y: 200 }, { width: 320, height: 240 }),
      makeNode('a1', 'agent', { x: 700, y: 50 }, { width: 900, height: 600 }),
      makeNode('e1', 'editor', { x: 0, y: 0 }, { width: 400, height: 400 })
    ];
    const out = unifyTerminalSize(nodes);
    expect(out.find((n) => n.id === 't1')?.position).toEqual({ x: 100, y: 200 });
    expect(out.find((n) => n.id === 'a1')?.position).toEqual({ x: 700, y: 50 });
    expect(out.find((n) => n.id === 't1')?.style?.width).toBe(NODE_W);
    expect(out.find((n) => n.id === 'a1')?.style?.height).toBe(NODE_H);
    // editor は触らない
    expect(out.find((n) => n.id === 'e1')?.style).toEqual({ width: 400, height: 400 });
  });

  it('returns input untouched when no terminal-like nodes', () => {
    const nodes: Node<CardData>[] = [makeNode('e1', 'editor', { x: 0, y: 0 })];
    const out = unifyTerminalSize(nodes);
    expect(out).toBe(nodes);
  });
});

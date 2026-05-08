import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import { findRecruitPosition } from '../canvas-recruit-position';
import type { CardData } from '../../stores/canvas';
import { NODE_H, NODE_W } from '../../stores/canvas';

/** 既定サイズ NODE_W × NODE_H 用テストノード factory */
function defaultNode(
  id: string,
  x: number,
  y: number,
  extra: Partial<Node<CardData>> = {}
): Node<CardData> {
  return {
    id,
    type: 'agent',
    position: { x, y },
    data: { cardType: 'agent', title: id },
    style: { width: NODE_W, height: NODE_H },
    ...extra
  };
}

/** 拡大サイズ用テストノード factory */
function resizedNode(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number
): Node<CardData> {
  return {
    id,
    type: 'agent',
    position: { x, y },
    data: { cardType: 'agent', title: id },
    style: { width, height }
  };
}

/** rect 同士の overlap 判定 (canvas-placement.ts の overlaps と同じ意味) */
function rect(x: number, y: number, w: number, h: number): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  return { left: x, top: y, right: x + w, bottom: y + h };
}

function overlaps(
  a: { left: number; top: number; right: number; bottom: number },
  b: { left: number; top: number; right: number; bottom: number }
): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

const stableScreen = () => 1920;

describe('findRecruitPosition', () => {
  describe('既定サイズ requester (regression)', () => {
    it('メンバー 0 名: 旧挙動どおり右側に配置 (cx + radius - NODE_W/2, cy - NODE_H/2)', () => {
      const requester = defaultNode('leader', 0, 0);
      const pos = findRecruitPosition(requester, [requester], { getScreenSize: stableScreen });

      // requesterOuter = NODE_W/2, childOuter = NODE_W/2, margin = 60
      // baseRadius = NODE_W + 60
      const radius = NODE_W + 60;
      const cx = NODE_W / 2;
      const cy = NODE_H / 2;
      expect(pos.x).toBeCloseTo(cx + radius - NODE_W / 2, 6);
      expect(pos.y).toBeCloseTo(cy - NODE_H / 2, 6);
    });

    it('メンバー 1 名: 1 人目と反対側に配置されて overlap しない', () => {
      const leader = defaultNode('leader', 0, 0);
      const first = defaultNode('first', NODE_W + 60, 0);
      const pos = findRecruitPosition(leader, [leader, first], { getScreenSize: stableScreen });

      const reqRect = rect(0, 0, NODE_W, NODE_H);
      const childRect = rect(pos.x, pos.y, NODE_W, NODE_H);
      const firstRect = rect(NODE_W + 60, 0, NODE_W, NODE_H);
      expect(overlaps(reqRect, childRect)).toBe(false);
      expect(overlaps(firstRect, childRect)).toBe(false);
    });

    it('メンバー 6 名以上: requester の右側 2 列グリッドに展開', () => {
      const leader = defaultNode('leader', 100, 200);
      const others = Array.from({ length: 5 }, (_, i) =>
        defaultNode(`m${i}`, i * 100, i * 100)
      );
      const pos = findRecruitPosition(leader, [leader, ...others], {
        getScreenSize: stableScreen
      });

      // newIdx = others.length = 5 (メンバーのうち leader 以外 = 5 名), col = 1, row = 2
      // 既定サイズ requester なので rW=NODE_W, x = leader.x + NODE_W + 32 + (NODE_W + 32) * 1
      const expectedX = 100 + NODE_W + 32 + (NODE_W + 32) * 1;
      const expectedY = 200 + (NODE_H + 32) * 2;
      expect(pos.x).toBe(expectedX);
      expect(pos.y).toBe(expectedY);
    });
  });

  describe('拡大 requester (Issue #569)', () => {
    it('メンバー 0 名: 拡大 requester でも overlap しない', () => {
      const leader = resizedNode('leader', 0, 0, 1200, 800);
      const pos = findRecruitPosition(leader, [leader], { getScreenSize: stableScreen });

      const reqRect = rect(0, 0, 1200, 800);
      const childRect = rect(pos.x, pos.y, NODE_W, NODE_H);
      expect(overlaps(reqRect, childRect)).toBe(false);
      // 子の左端が requester の右端より外側にある
      expect(pos.x).toBeGreaterThanOrEqual(1200);
    });

    it('メンバー 1 名: 拡大 requester / 既存メンバーの両方と overlap しない', () => {
      const leader = resizedNode('leader', 0, 0, 1200, 800);
      const first = defaultNode('first', 1500, 100);
      const pos = findRecruitPosition(leader, [leader, first], { getScreenSize: stableScreen });

      const reqRect = rect(0, 0, 1200, 800);
      const childRect = rect(pos.x, pos.y, NODE_W, NODE_H);
      const firstRect = rect(1500, 100, NODE_W, NODE_H);
      expect(overlaps(reqRect, childRect)).toBe(false);
      expect(overlaps(firstRect, childRect)).toBe(false);
    });

    it('メンバー 6 名以上 (grid): 1 列目の x 起点が requester の右端 + GRID_COL_GAP', () => {
      const leader = resizedNode('leader', 100, 200, 1200, 800);
      const others = Array.from({ length: 5 }, (_, i) =>
        defaultNode(`m${i}`, 5000 + i * 100, 5000 + i * 100)
      );
      const pos = findRecruitPosition(leader, [leader, ...others], {
        getScreenSize: stableScreen
      });

      // newIdx=5 → col=1, row=2
      // 起点 x = leader.x + rW + 32 + (NODE_W + 32) * 1
      const expectedX = 100 + 1200 + 32 + (NODE_W + 32) * 1;
      const expectedY = 200 + (NODE_H + 32) * 2;
      expect(pos.x).toBe(expectedX);
      expect(pos.y).toBe(expectedY);
    });

    it('縦長 requester でも overlap しない (rH > NODE_H)', () => {
      const leader = resizedNode('leader', 0, 0, NODE_W, 1500);
      const pos = findRecruitPosition(leader, [leader], { getScreenSize: stableScreen });

      const reqRect = rect(0, 0, NODE_W, 1500);
      const childRect = rect(pos.x, pos.y, NODE_W, NODE_H);
      expect(overlaps(reqRect, childRect)).toBe(false);
    });
  });

  describe('screen-size cap', () => {
    it('小画面でも overlap 回避を優先 (baseRadius を effectiveCap で下回らない)', () => {
      const leader = resizedNode('leader', 0, 0, 1200, 800);
      // 極端な小画面: cap = max(NODE_W, 200 * 0.45) = NODE_W (760) になる
      // しかし baseRadius = max(1200,800)/2 + max(NODE_W,NODE_H)/2 + 60
      //                 = 600 + 380 + 60 = 1040 > cap なので effectiveCap = baseRadius
      const pos = findRecruitPosition(leader, [leader], { getScreenSize: () => 200 });

      const reqRect = rect(0, 0, 1200, 800);
      const childRect = rect(pos.x, pos.y, NODE_W, NODE_H);
      expect(overlaps(reqRect, childRect)).toBe(false);
    });
  });
});

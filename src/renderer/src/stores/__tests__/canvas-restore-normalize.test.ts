/**
 * Canvas store の正規化 (Issue #385) を直接テストする。
 * - persist v3 → v4 の migration を経ても黒画面化しない
 * - 同 version (v4 → v4) の rehydrate でも runtime に紛れ込んだ NaN viewport を補正する
 * - 極端な座標 / zoom が起動時に修正される
 */
import { describe, expect, it } from 'vitest';
import { __testables } from '../canvas';

const { normalizeCanvasState, VIEWPORT_MIN_ZOOM, VIEWPORT_MAX_ZOOM, VIEWPORT_RESCUE_DISTANCE } =
  __testables;

describe('normalizeCanvasState (Issue #385)', () => {
  it('null / 非オブジェクト入力は空 state にフォールバック', () => {
    const out = normalizeCanvasState(null);
    expect(out.nodes).toEqual([]);
    expect(out.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(out.stageView).toBe('stage');
    expect(out.teamLocks).toEqual({});
    expect(out.arrangeGap).toBe('normal');
  });

  it('viewport.zoom が NaN / Infinity / 負値 / 上限超過のときクランプされる', () => {
    expect(
      normalizeCanvasState({ nodes: [], viewport: { x: 0, y: 0, zoom: NaN } })
        .viewport.zoom
    ).toBe(1);
    expect(
      normalizeCanvasState({ nodes: [], viewport: { x: 0, y: 0, zoom: 0 } })
        .viewport.zoom
    ).toBe(VIEWPORT_MIN_ZOOM);
    expect(
      normalizeCanvasState({
        nodes: [],
        viewport: { x: 0, y: 0, zoom: Number.POSITIVE_INFINITY }
      }).viewport.zoom
    ).toBe(VIEWPORT_MAX_ZOOM);
    expect(
      normalizeCanvasState({ nodes: [], viewport: { x: 0, y: 0, zoom: 100 } })
        .viewport.zoom
    ).toBe(VIEWPORT_MAX_ZOOM);
    expect(
      normalizeCanvasState({ nodes: [], viewport: { x: 0, y: 0, zoom: -2 } })
        .viewport.zoom
    ).toBe(VIEWPORT_MIN_ZOOM);
  });

  it('nodes ありで viewport が極端な値なら 0,0 へ復帰する', () => {
    const node = {
      id: 'a-1',
      type: 'agent',
      position: { x: 0, y: 0 },
      data: { cardType: 'agent', title: 'Leader' },
      style: { width: 640, height: 400 }
    };
    const out = normalizeCanvasState({
      nodes: [node],
      viewport: { x: VIEWPORT_RESCUE_DISTANCE + 1, y: 0, zoom: 1 }
    });
    expect(out.viewport.x).toBe(0);
    expect(out.viewport.y).toBe(0);
  });

  it('nodes が空のときは極端な viewport 値はそのまま (= 操作で復帰可能)', () => {
    const out = normalizeCanvasState({
      nodes: [],
      viewport: { x: VIEWPORT_RESCUE_DISTANCE + 1, y: 0, zoom: 1 }
    });
    expect(out.viewport.x).toBe(VIEWPORT_RESCUE_DISTANCE + 1);
  });

  it('壊れた node (type 不明 / position が NaN / style 欠損) は安全な形に直る', () => {
    const out = normalizeCanvasState({
      nodes: [
        // type 不明 → 捨てられる
        { id: 'broken', type: 'unknown', position: { x: 0, y: 0 } },
        {
          id: 'a-2',
          type: 'agent',
          position: { x: NaN, y: 'oops' },
          data: { cardType: 'agent', title: '' },
          style: { width: 'bad', height: undefined }
        }
      ],
      viewport: { x: 0, y: 0, zoom: 1 }
    });
    expect(out.nodes).toHaveLength(1);
    const n = out.nodes[0]!;
    expect(Number.isFinite(n.position.x)).toBe(true);
    expect(Number.isFinite(n.position.y)).toBe(true);
    expect((n.style as { width: number }).width).toBe(640);
    expect((n.style as { height: number }).height).toBe(400);
    expect(n.data.title).toBe('Card'); // 空タイトル → 'Card'
  });

  it('node.id が無くても自動採番されて落ちない', () => {
    const out = normalizeCanvasState({
      nodes: [
        {
          type: 'terminal',
          position: { x: 0, y: 0 },
          data: { cardType: 'terminal', title: 'T' }
        }
      ]
    });
    expect(out.nodes).toHaveLength(1);
    expect(typeof out.nodes[0]!.id).toBe('string');
    expect(out.nodes[0]!.id.length).toBeGreaterThan(0);
  });

  it('teamLocks に boolean 以外の値が混じっていても落とす', () => {
    const out = normalizeCanvasState({
      nodes: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      teamLocks: { team1: true, team2: 'oops', team3: false }
    });
    expect(out.teamLocks).toEqual({ team1: true, team3: false });
  });

  it('stageView が不正値ならデフォルト stage に戻す', () => {
    expect(
      normalizeCanvasState({ stageView: 'evil' }).stageView
    ).toBe('stage');
    expect(
      normalizeCanvasState({ stageView: 'list' }).stageView
    ).toBe('list');
  });

  it('arrangeGap が不正値なら normal に戻す', () => {
    expect(normalizeCanvasState({ arrangeGap: 999 }).arrangeGap).toBe('normal');
    expect(normalizeCanvasState({ arrangeGap: 'tight' }).arrangeGap).toBe('tight');
  });

  it('node.position が有限でも rescue 距離超なら fallback grid に戻す (codex review #3)', () => {
    const out = normalizeCanvasState({
      nodes: [
        {
          id: 't-far',
          type: 'terminal',
          position: { x: VIEWPORT_RESCUE_DISTANCE + 100, y: 0 },
          data: { cardType: 'terminal', title: 'Stranded' },
          style: { width: 640, height: 400 }
        }
      ],
      viewport: { x: 0, y: 0, zoom: 1 }
    });
    // index 0 → grid 0,0
    expect(out.nodes[0]!.position.x).toBe(0);
    expect(out.nodes[0]!.position.y).toBe(0);
  });

  it('node.position の片軸だけ極端なら片軸だけ rescue する', () => {
    const out = normalizeCanvasState({
      nodes: [
        {
          id: 't-half',
          type: 'terminal',
          position: { x: 50, y: -VIEWPORT_RESCUE_DISTANCE - 1 },
          data: { cardType: 'terminal', title: 'HalfStranded' },
          style: { width: 640, height: 400 }
        }
      ]
    });
    expect(out.nodes[0]!.position.x).toBe(50); // 維持
    expect(out.nodes[0]!.position.y).toBe(0); // grid に戻す
  });
});

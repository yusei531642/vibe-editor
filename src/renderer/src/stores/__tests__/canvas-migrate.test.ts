/**
 * Canvas store の persist migration を、persist middleware を介さずに
 * 状態オブジェクト直書きで再現してテストする。
 *
 * Issue #253 (v2 → v3): 旧 NODE_W/H (480x320) で永続化された小さいカードを 640x400 に拡大する。
 *   ユーザー手動拡大値 (>480 / >320) は尊重する。
 * Issue #497 (v4 → v5): 640x400 (= 旧 v3 既定) のカードを新既定 760x460 に拡大する。
 *   ユーザー手動拡大値 (>640 / >400) は尊重する。
 *
 * 古い fromVersion からの呼び出しは ladder で v2→v3→…→v5 と段階的に進むため、
 * v1 / v2 入力のテストは「最終的に 760x460 になる」ことを期待する。
 */
import { describe, it, expect, beforeEach } from 'vitest';

// migrate を pure function として取得する。store state には依存しない。
async function loadStore() {
  return await import('../canvas');
}

describe('canvas persist migrate (Issue #253 / #497)', () => {
  beforeEach(() => {
    // jsdom localStorage を毎テストでクリアして persist 由来の干渉を防ぐ
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
  });

  it('v2 → v5: width<=480 / height<=320 のノードは 760/460 に拡大される', async () => {
    const { useCanvasStore } = await loadStore();
    const persistApi = useCanvasStore.persist;
    const migrate = persistApi.getOptions().migrate!;

    const v2State = {
      nodes: [
        {
          id: 't-1',
          type: 'terminal',
          position: { x: 0, y: 0 },
          data: { cardType: 'terminal', title: 'Terminal' },
          style: { width: 480, height: 320 }
        }
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
      stageView: 'stage',
      teamLocks: {}
    };
    const result = migrate(v2State, 2) as { nodes: { style: { width: number; height: number } }[] };
    expect(result.nodes[0].style.width).toBe(760);
    expect(result.nodes[0].style.height).toBe(460);
  });

  it('v2 → v5: width>640 のノードはユーザー手動拡大値として尊重される', async () => {
    const { useCanvasStore } = await loadStore();
    const migrate = useCanvasStore.persist.getOptions().migrate!;

    const v2State = {
      nodes: [
        {
          id: 't-2',
          type: 'terminal',
          position: { x: 0, y: 0 },
          data: { cardType: 'terminal', title: 'Big' },
          style: { width: 1000, height: 600 }
        }
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
      stageView: 'stage',
      teamLocks: {}
    };
    const result = migrate(v2State, 2) as { nodes: { style: { width: number; height: number } }[] };
    expect(result.nodes[0].style.width).toBe(1000);
    expect(result.nodes[0].style.height).toBe(600);
  });

  it('v2 → v5: 中間サイズ (width=600, height=320) は ladder で両軸 760/460 に拡大される', async () => {
    const { useCanvasStore } = await loadStore();
    const migrate = useCanvasStore.persist.getOptions().migrate!;

    // width=600 は v2→v3 では尊重 (>480) だが v4→v5 では <=640 で 760 に拡大される。
    // height=320 は v2→v3 で 400 になり、v4→v5 で <=400 のため 460 に拡大される。
    const v2State = {
      nodes: [
        {
          id: 't-3',
          type: 'terminal',
          position: { x: 0, y: 0 },
          data: { cardType: 'terminal', title: 'Mid' },
          style: { width: 600, height: 320 }
        }
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
      stageView: 'stage',
      teamLocks: {}
    };
    const result = migrate(v2State, 2) as { nodes: { style: { width: number; height: number } }[] };
    expect(result.nodes[0].style.width).toBe(760);
    expect(result.nodes[0].style.height).toBe(460);
  });

  it('v1 → v5: payload.role リネーム + size 拡大の両方が適用される', async () => {
    const { useCanvasStore } = await loadStore();
    const migrate = useCanvasStore.persist.getOptions().migrate!;

    const v1State = {
      nodes: [
        {
          id: 'a-1',
          type: 'agent',
          position: { x: 0, y: 0 },
          data: {
            cardType: 'agent',
            title: 'Leader',
            payload: { role: 'leader' }
          },
          style: { width: 480, height: 320 }
        }
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
      stageView: 'stage',
      teamLocks: {}
    };
    type Migrated = {
      nodes: {
        style: { width: number; height: number };
        data: { payload: { role?: string; roleProfileId?: string } };
      }[];
    };
    const result = migrate(v1State, 1) as Migrated;
    expect(result.nodes[0].style.width).toBe(760);
    expect(result.nodes[0].style.height).toBe(460);
    expect(result.nodes[0].data.payload.roleProfileId).toBe('leader');
  });

  it('v2 → v5: 壊れた nodes (style 欠損) は最終正規化で width=760 / height=460 のデフォルトが入る', async () => {
    const { useCanvasStore } = await loadStore();
    const migrate = useCanvasStore.persist.getOptions().migrate!;

    const v2State = {
      nodes: [
        {
          id: 't-4',
          type: 'terminal',
          position: { x: 0, y: 0 },
          data: { cardType: 'terminal', title: 'Broken' }
          // style がない
        }
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
      stageView: 'stage',
      teamLocks: {}
    };
    const result = migrate(v2State, 2) as { nodes: { style: { width: number; height: number } }[] };
    expect(result.nodes[0].style.width).toBe(760);
    expect(result.nodes[0].style.height).toBe(460);
  });

  it('v2 → v5: nodes 配列が空でもクラッシュしない', async () => {
    const { useCanvasStore } = await loadStore();
    const migrate = useCanvasStore.persist.getOptions().migrate!;

    const v2State = {
      nodes: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      stageView: 'stage',
      teamLocks: {}
    };
    const result = migrate(v2State, 2) as { nodes: unknown[] };
    expect(Array.isArray(result.nodes)).toBe(true);
    expect(result.nodes).toHaveLength(0);
  });

  // Issue #497 v4 → v5: 単独 step の挙動を直接検証する (v3→v4 が no-op なのでこの組合せが本質)。
  it('v4 → v5: width<=640 / height<=400 のノードは 760/460 に拡大される', async () => {
    const { useCanvasStore } = await loadStore();
    const migrate = useCanvasStore.persist.getOptions().migrate!;

    const v4State = {
      nodes: [
        {
          id: 't-5',
          type: 'terminal',
          position: { x: 0, y: 0 },
          data: { cardType: 'terminal', title: 'Old default' },
          style: { width: 640, height: 400 }
        }
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
      stageView: 'stage',
      teamLocks: {}
    };
    const result = migrate(v4State, 4) as { nodes: { style: { width: number; height: number } }[] };
    expect(result.nodes[0].style.width).toBe(760);
    expect(result.nodes[0].style.height).toBe(460);
  });

  it('v4 → v5: 手動拡大値 (>640 / >400) は維持される', async () => {
    const { useCanvasStore } = await loadStore();
    const migrate = useCanvasStore.persist.getOptions().migrate!;

    const v4State = {
      nodes: [
        {
          id: 't-6',
          type: 'terminal',
          position: { x: 0, y: 0 },
          data: { cardType: 'terminal', title: 'Manual big' },
          style: { width: 900, height: 700 }
        }
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
      stageView: 'stage',
      teamLocks: {}
    };
    const result = migrate(v4State, 4) as { nodes: { style: { width: number; height: number } }[] };
    expect(result.nodes[0].style.width).toBe(900);
    expect(result.nodes[0].style.height).toBe(700);
  });

  it('v4 → v5: 中間サイズは軸ごとに独立判定される (width=800 維持 / height=400 拡大)', async () => {
    const { useCanvasStore } = await loadStore();
    const migrate = useCanvasStore.persist.getOptions().migrate!;

    const v4State = {
      nodes: [
        {
          id: 't-7',
          type: 'terminal',
          position: { x: 0, y: 0 },
          data: { cardType: 'terminal', title: 'Wide manual' },
          style: { width: 800, height: 400 }
        }
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
      stageView: 'stage',
      teamLocks: {}
    };
    const result = migrate(v4State, 4) as { nodes: { style: { width: number; height: number } }[] };
    expect(result.nodes[0].style.width).toBe(800); // ユーザー拡大値で尊重
    expect(result.nodes[0].style.height).toBe(460); // 旧既定相当 → 拡大
  });
});

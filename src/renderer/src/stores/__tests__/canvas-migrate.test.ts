/**
 * Canvas store の persist migration (v2 → v3) を、persist middleware を介さずに
 * 状態オブジェクト直書きで再現してテストする。
 *
 * Issue #253: 旧 NODE_W/H (480x320) で永続化された小さいカードを NODE_W/H (640x400) に
 * 拡大する。ユーザー手動拡大値 (>480 / >320) は尊重する。
 */
import { describe, it, expect, beforeEach } from 'vitest';

// Issue #253 review (W#3): migrate を pure function として取得する。
// store state には依存しない。Vitest の動的 import は通常モジュールキャッシュを使う
// (vi.resetModules() なしでは 2 回目以降同一インスタンスが返る) ので、本関数は
// 「migrate 関数を引っ張り出すための薄いラッパー」として機能している。
// テストは `useCanvasStore.persist.getOptions().migrate!` を pure function として呼ぶだけで、
// store 内部の hydrated state には触れないため、キャッシュされていても動作に影響しない。
async function loadStore() {
  return await import('../canvas');
}

describe('canvas persist migrate (Issue #253 v3)', () => {
  beforeEach(() => {
    // jsdom localStorage を毎テストでクリアして persist 由来の干渉を防ぐ
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
  });

  it('v2 → v3: width<=480 / height<=320 のノードは 640/400 に拡大される', async () => {
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
    expect(result.nodes[0].style.width).toBe(640);
    expect(result.nodes[0].style.height).toBe(400);
  });

  it('v2 → v3: width>480 のノードはユーザー手動拡大値として尊重される', async () => {
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

  it('v2 → v3: 中間サイズ (width=600, height=320) は片方だけ引き上げ', async () => {
    const { useCanvasStore } = await loadStore();
    const migrate = useCanvasStore.persist.getOptions().migrate!;

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
    expect(result.nodes[0].style.width).toBe(600); // ユーザー拡大値で尊重
    expect(result.nodes[0].style.height).toBe(400); // 旧デフォルト相当 → 拡大
  });

  it('v1 → v3: payload.role リネーム + size 拡大の両方が適用される', async () => {
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
    expect(result.nodes[0].style.width).toBe(640);
    expect(result.nodes[0].style.height).toBe(400);
    expect(result.nodes[0].data.payload.roleProfileId).toBe('leader');
  });

  it('v2 → v3: 壊れた nodes (style 欠損) は最終正規化で width=640 / height=400 のデフォルトが入る', async () => {
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
    expect(result.nodes[0].style.width).toBe(640);
    expect(result.nodes[0].style.height).toBe(400);
  });

  it('v2 → v3: nodes 配列が空でもクラッシュしない', async () => {
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
});

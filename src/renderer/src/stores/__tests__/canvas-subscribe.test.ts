/**
 * Issue #253 review (W#2): subscribeWithSelector ミドルウェアが persist の outer に
 * 配置されていることを検証する単体テスト。順序を逆転させると selector subscribe
 * (`useCanvasStore.subscribe(selector, listener)`) が動かなくなり、useCanvasTerminalFit の
 * zoomSubscribe が毎フレーム発火する silent breakage になる。型レベルでは検出できないので
 * このテストでガードする。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('useCanvasStore subscribeWithSelector middleware (Issue #253 W#2)', () => {
  beforeEach(() => {
    if (typeof localStorage !== 'undefined') localStorage.clear();
  });

  it('selector subscribe で量子化された値の変化のみ listener が発火する', async () => {
    const { useCanvasStore } = await import('../canvas');
    const setViewport = useCanvasStore.getState().setViewport;
    const initialZoom = useCanvasStore.getState().viewport.zoom;
    const quantize = (z: number): number => Math.round(z * 100) / 100;

    let count = 0;
    const unsubscribe = useCanvasStore.subscribe(
      (state) => quantize(state.viewport.zoom),
      () => {
        count++;
      }
    );

    // 量子化後の値が変わらない範囲の zoom 変更 → listener は発火しない
    setViewport({ x: 0, y: 0, zoom: initialZoom });
    setViewport({ x: 0, y: 0, zoom: initialZoom + 0.001 });
    setViewport({ x: 0, y: 0, zoom: initialZoom + 0.0049 });
    expect(count).toBe(0);

    // 量子化後の値が変わる zoom 変更 → listener が 1 回発火
    setViewport({ x: 0, y: 0, zoom: initialZoom + 0.5 });
    expect(count).toBe(1);

    // 同じ値で再度 setViewport → listener 発火しない
    setViewport({ x: 0, y: 0, zoom: initialZoom + 0.5 });
    expect(count).toBe(1);

    // また異なる量子化値 → listener 発火
    setViewport({ x: 0, y: 0, zoom: initialZoom + 1.0 });
    expect(count).toBe(2);

    unsubscribe();
  });

  it('selector subscribe で zoom 以外の state 変更では listener が発火しない', async () => {
    const { useCanvasStore } = await import('../canvas');
    const setStageView = useCanvasStore.getState().setStageView;

    let count = 0;
    const unsubscribe = useCanvasStore.subscribe(
      (state) => Math.round(state.viewport.zoom * 100) / 100,
      () => {
        count++;
      }
    );

    // viewport を変えずに別フィールドを変える → listener 発火しない
    setStageView('list');
    setStageView('focus');
    expect(count).toBe(0);

    unsubscribe();
  });

  it('useCanvasStore.subscribe が selector + listener (2 引数) 形式を受け付ける', async () => {
    const { useCanvasStore } = await import('../canvas');
    // 2 引数 subscribe を呼んでもエラーにならない (subscribeWithSelector が外側にある証拠)。
    // 順序逆転 (persist が外側) だと selector が listener として呼ばれて毎フレーム発火する
    // silent breakage が起きる。本テストは「型は通るが意味的に壊れている」状態の検出は
    // できないが、API 形式の存在自体は検証できる。
    const unsubscribe = useCanvasStore.subscribe(
      (s) => s.viewport.zoom,
      () => undefined
    );
    expect(typeof unsubscribe).toBe('function');
    unsubscribe();
  });

  it('drag 中の nodes 更新は localStorage persist を skip し、drag 終了時に一度だけ flush する (Issue #835)', async () => {
    const { useCanvasStore } = await import('../canvas');
    const store = useCanvasStore.getState();
    store.clear();

    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    setItemSpy.mockClear();

    store.setCanvasDragging(true);
    store.setNodes([
      {
        id: 'agent-issue-835',
        type: 'agent',
        position: { x: 10, y: 20 },
        data: { cardType: 'agent', title: 'agent', payload: { agent: 'claude' } },
        style: { width: 760, height: 460 }
      }
    ]);
    store.setNodes([
      {
        id: 'agent-issue-835',
        type: 'agent',
        position: { x: 30, y: 40 },
        data: { cardType: 'agent', title: 'agent', payload: { agent: 'claude' } },
        style: { width: 760, height: 460 }
      }
    ]);

    expect(
      setItemSpy.mock.calls.some(([name]) => name === 'vibe-editor:canvas')
    ).toBe(false);

    store.setCanvasDragging(false);

    const canvasWrites = setItemSpy.mock.calls.filter(
      ([name]) => name === 'vibe-editor:canvas'
    );
    expect(canvasWrites).toHaveLength(1);
    const [, raw] = canvasWrites[canvasWrites.length - 1];
    const saved = JSON.parse(String(raw)) as {
      state: { nodes: Array<{ id: string; position: { x: number; y: number } }> };
    };
    expect(saved.state.nodes).toHaveLength(1);
    expect(saved.state.nodes[0].id).toBe('agent-issue-835');
    expect(saved.state.nodes[0].position).toEqual({ x: 30, y: 40 });

    setItemSpy.mockRestore();
  });
});

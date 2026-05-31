import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { Dispatch, SetStateAction } from 'react';
import { useCanvasAutoSave } from '../use-canvas-auto-save';
import type { CardData } from '../../../stores/canvas';
import type { TeamHistoryEntry } from '../../../../../types/shared';

// Issue #841: window.api の実型 (Api) と部分 mock は構造的に重ならないため、
// 他テスト (DiffCard.test.tsx 等) と同じく `api?: unknown` で受ける。
type TestWindow = Omit<Window, 'api'> &
  typeof globalThis & {
    api?: unknown;
  };

function makeAgentNode(): Node<CardData> {
  return {
    id: 'agent-card',
    type: 'agent',
    position: { x: 12.2, y: 34.7 },
    width: 900,
    height: 700,
    data: {
      cardType: 'agent',
      title: 'Leader',
      payload: {
        agent: 'claude',
        teamId: 'team-1',
        agentId: 'leader-1',
        roleProfileId: 'leader'
      }
    },
    style: { width: 500, height: 300 }
  } as Node<CardData>;
}

describe('useCanvasAutoSave (Issue #894)', () => {
  let originalApi: unknown;
  let saveBatch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    originalApi = (window as TestWindow).api;
    saveBatch = vi.fn(async () => ({ externalChangeMerged: false }));
    (window as TestWindow).api = {
      teamHistory: {
        saveBatch,
        list: vi.fn(async () => [])
      }
    };
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    if (originalApi === undefined) {
      Reflect.deleteProperty(window, 'api');
    } else {
      (window as TestWindow).api = originalApi as TestWindow['api'];
    }
    vi.restoreAllMocks();
  });

  it('team-history には style ではなく React Flow の実描画 width/height を保存する', async () => {
    const setRecent = vi.fn() as unknown as Dispatch<SetStateAction<TeamHistoryEntry[]>>;
    renderHook(() =>
      useCanvasAutoSave({
        projectRoot: '/repo',
        nodes: [makeAgentNode()],
        viewport: { x: 0, y: 0, zoom: 1 },
        recent: [],
        setRecent
      })
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });

    expect(saveBatch).toHaveBeenCalledTimes(1);
    const entries = saveBatch.mock.calls[0]![0] as TeamHistoryEntry[];
    expect(entries[0].canvasState?.nodes[0]).toMatchObject({
      agentId: 'leader-1',
      x: 12,
      y: 35,
      width: 900,
      height: 700
    });
  });
});

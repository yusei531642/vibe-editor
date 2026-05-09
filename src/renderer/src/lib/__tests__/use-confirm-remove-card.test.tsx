/**
 * useConfirmRemoveCard の confirm 経路テスト (Issue #595)。
 *
 * - dirty な EditorCard が居る場合は window.confirm が呼ばれ、cancel すると removeCard が走らない
 * - 確認 OK の場合は removeCard が走る
 * - dirty 無しなら追加 confirm を出さずにそのまま removeCard する
 * - team cascade で dirty editor が巻き込まれる場合も confirm が出る
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useConfirmRemoveCard } from '../use-confirm-remove-card';
import { useCanvasStore } from '../../stores/canvas';
import {
  __resetEditorCardDirtyRegistry,
  registerEditorCardDirty
} from '../editor-card-dirty-registry';
import { SettingsProvider } from '../settings-context';
import { ToastProvider } from '../toast-context';
import { DEFAULT_SETTINGS } from '../../../../types/shared';

type TestWindow = Window &
  typeof globalThis & {
    api?: unknown;
  };

function installApiStub(): void {
  (window as TestWindow).api = {
    settings: {
      load: vi.fn(async () => DEFAULT_SETTINGS),
      save: vi.fn(async () => undefined)
    },
    app: {
      setProjectRoot: vi.fn(async () => undefined),
      setZoomLevel: vi.fn(async () => undefined)
    }
  };
}

function Wrapper({ children }: { children: ReactNode }): JSX.Element {
  return (
    <SettingsProvider>
      <ToastProvider>{children}</ToastProvider>
    </SettingsProvider>
  );
}

function setupCanvas(
  nodes: { id: string; type: string; payload?: Record<string, unknown> }[]
): void {
  useCanvasStore.setState({
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: { x: 0, y: 0 },
      data: { cardType: n.type as never, title: n.id, payload: n.payload }
    })) as never,
    edges: [],
    teamLocks: {}
  } as never);
}

describe('useConfirmRemoveCard (Issue #595)', () => {
  let originalApi: unknown;
  let confirmSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalApi = (window as TestWindow).api;
    installApiStub();
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    __resetEditorCardDirtyRegistry();
    useCanvasStore.setState({ nodes: [], edges: [], teamLocks: {} } as never);
  });

  afterEach(() => {
    if (originalApi === undefined) {
      delete (window as TestWindow).api;
    } else {
      (window as TestWindow).api = originalApi;
    }
    __resetEditorCardDirtyRegistry();
    useCanvasStore.setState({ nodes: [], edges: [], teamLocks: {} } as never);
    confirmSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('単一 dirty EditorCard を × で閉じようとすると confirm が出る', () => {
    setupCanvas([{ id: 'editor-1', type: 'editor' }]);
    registerEditorCardDirty('editor-1', () => ({ relPath: 'src/foo.ts', isDirty: true }));
    confirmSpy.mockReturnValue(true);

    const { result } = renderHook(() => useConfirmRemoveCard(), { wrapper: Wrapper });
    result.current('editor-1');

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0][0]).toContain('src/foo.ts');
    expect(useCanvasStore.getState().nodes).toEqual([]);
  });

  it('dirty EditorCard で confirm cancel すると removeCard は呼ばれず content が残る', () => {
    setupCanvas([{ id: 'editor-1', type: 'editor' }]);
    registerEditorCardDirty('editor-1', () => ({ relPath: 'src/foo.ts', isDirty: true }));
    confirmSpy.mockReturnValue(false);

    const { result } = renderHook(() => useConfirmRemoveCard(), { wrapper: Wrapper });
    result.current('editor-1');

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(useCanvasStore.getState().nodes).toHaveLength(1);
  });

  it('dirty で無い EditorCard は追加 confirm を出さずに即削除する', () => {
    setupCanvas([{ id: 'editor-1', type: 'editor' }]);
    registerEditorCardDirty('editor-1', () => ({ relPath: 'src/foo.ts', isDirty: false }));

    const { result } = renderHook(() => useConfirmRemoveCard(), { wrapper: Wrapper });
    result.current('editor-1');

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().nodes).toEqual([]);
  });

  it('team cascade で dirty EditorCard が巻き込まれるなら editor confirm まで通る', () => {
    setupCanvas([
      { id: 'leader-1', type: 'agent', payload: { teamId: 'team-x', teamName: 'Alpha' } },
      { id: 'worker-1', type: 'agent', payload: { teamId: 'team-x' } },
      { id: 'editor-1', type: 'editor', payload: { teamId: 'team-x' } }
    ]);
    registerEditorCardDirty('editor-1', () => ({ relPath: 'src/foo.ts', isDirty: true }));
    confirmSpy.mockReturnValue(true);

    const { result } = renderHook(() => useConfirmRemoveCard(), { wrapper: Wrapper });
    result.current('leader-1');

    expect(confirmSpy).toHaveBeenCalledTimes(2);
    expect(confirmSpy.mock.calls[0][0]).toMatch(/Alpha|3/);
    expect(confirmSpy.mock.calls[1][0]).toContain('src/foo.ts');
    expect(useCanvasStore.getState().nodes).toEqual([]);
  });

  it('team cascade で 1 回目をキャンセルすれば editor confirm まで進まず何も削除されない', () => {
    setupCanvas([
      { id: 'leader-1', type: 'agent', payload: { teamId: 'team-x' } },
      { id: 'worker-1', type: 'agent', payload: { teamId: 'team-x' } },
      { id: 'editor-1', type: 'editor', payload: { teamId: 'team-x' } }
    ]);
    registerEditorCardDirty('editor-1', () => ({ relPath: 'src/foo.ts', isDirty: true }));
    confirmSpy.mockReturnValue(false);

    const { result } = renderHook(() => useConfirmRemoveCard(), { wrapper: Wrapper });
    result.current('leader-1');

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(useCanvasStore.getState().nodes).toHaveLength(3);
  });
});

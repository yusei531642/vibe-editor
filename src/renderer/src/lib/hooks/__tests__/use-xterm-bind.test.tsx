/**
 * use-xterm-bind の lifecycle smoke test。
 *
 * Issue #495: PR #489 で `use-pty-session.ts` から切り出された PTY 配線 hook 本体の
 * 「期待される表面挙動」を最小限のモックで固定する。
 *
 * 検証範囲:
 *   1. mount 直後に `terminal.create` が呼ばれ、cwd / command が正しく渡る
 *   2. 不変式 #2 (PtySpawnSnapshot 切り出し): args / teamId 等は spawn 時の snapRef 値が
 *      渡され、以後 props を変えても影響しない
 *   3. unmount で IPC `terminal.kill` が呼ばれる (HMR 経路ではない通常 cleanup)
 *
 * 詳細な race / HMR / attach 経路は `use-pty-session-fonts.test.tsx` などで
 * 個別カバーされており、ここでは「最小 spawn → unmount の 1 ラウンド」に絞る。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import {
  useXtermBind,
  type PtySessionCallbacks,
  type PtySpawnSnapshot
} from '../use-xterm-bind';

type TestWindow = Window &
  typeof globalThis & {
    api?: unknown;
  };

type TestTerminal = Terminal & {
  textarea: HTMLTextAreaElement;
};

function makeRef<T>(current: T): MutableRefObject<T> {
  return { current };
}

function makeTerminal(): TestTerminal {
  const term = {
    cols: 80,
    rows: 24,
    textarea: document.createElement('textarea'),
    write: vi.fn(),
    writeln: vi.fn(),
    resize: vi.fn(),
    refresh: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() }))
  } as unknown as TestTerminal;
  return term;
}

describe('useXtermBind: spawn → unmount lifecycle', () => {
  let originalApi: unknown;
  let originalFontsDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalApi = (window as TestWindow).api;
    originalFontsDescriptor = Object.getOwnPropertyDescriptor(document, 'fonts');
    // fonts.ready が即時 resolve するように上書き (loadInitialMetrics の 300ms タイムアウト経路を
    // 待たずに spawn まで進める)。
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: Promise.resolve() } as Partial<FontFaceSet>
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    if (originalApi === undefined) {
      delete (window as TestWindow).api;
    } else {
      (window as TestWindow).api = originalApi;
    }
    if (originalFontsDescriptor) {
      Object.defineProperty(document, 'fonts', originalFontsDescriptor);
    } else {
      delete (document as Document & { fonts?: unknown }).fonts;
    }
  });

  it('mount で terminal.create が呼ばれ、unmount で kill が呼ばれる', async () => {
    const term = makeTerminal();
    const fit = { fit: vi.fn() } as unknown as FitAddon;
    const create = vi.fn(async (opts: { id?: string }) => ({
      ok: true,
      id: opts.id ?? 'pty-test-1'
    }));
    const kill = vi.fn(async () => undefined);

    (window as TestWindow).api = {
      terminal: {
        onDataReady: vi.fn(async () => vi.fn()),
        onExitReady: vi.fn(async () => vi.fn()),
        onSessionIdReady: vi.fn(async () => vi.fn()),
        onData: vi.fn(() => vi.fn()),
        onExit: vi.fn(() => vi.fn()),
        onSessionId: vi.fn(() => vi.fn()),
        create,
        write: vi.fn(async () => undefined),
        resize: vi.fn(async () => undefined),
        kill
      }
    };

    const ptyIdRef = makeRef<string | null>(null);

    const { unmount } = renderHook(() =>
      useXtermBind({
        cwd: '/tmp/work',
        command: 'claude',
        termRef: makeRef<Terminal | null>(term),
        fitRef: makeRef<FitAddon | null>(fit),
        snapRef: makeRef<PtySpawnSnapshot>({
          args: ['--print'],
          teamId: 'team-1',
          agentId: 'leader-1'
        }),
        callbacksRef: makeRef<PtySessionCallbacks>({}),
        ptyIdRef,
        disposedRef: makeRef(false),
        observeChunk: vi.fn(),
        unscaledFit: false
      })
    );

    // fonts.ready resolve → loadInitialMetrics 完了 → terminal.create 呼び出しまで待つ。
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const createArg = create.mock.calls[0][0] as { id?: string };
    expect(createArg).toMatchObject({
      cwd: '/tmp/work',
      command: 'claude',
      args: ['--print'],
      teamId: 'team-1',
      agentId: 'leader-1'
    });
    // pre-subscribe 経路では client-generated id が使われる (UUID)。
    // ptyIdRef にも同じ id が伝播する。
    expect(typeof createArg.id).toBe('string');
    const spawnedId = createArg.id as string;
    await waitFor(() => expect(ptyIdRef.current).toBe(spawnedId));

    // 通常の unmount (sessionKey 未指定 → HMR キャッシュ経路には入らない) では kill が呼ばれる。
    await act(async () => {
      unmount();
      await Promise.resolve();
    });
    expect(kill).toHaveBeenCalledWith(spawnedId);
  });

  it('terminal.create が ok:false を返した場合は kill しない (spawn 失敗経路)', async () => {
    const term = makeTerminal();
    const fit = { fit: vi.fn() } as unknown as FitAddon;
    const create = vi.fn(async () => ({
      ok: false,
      id: '',
      error: 'spawn failed: command not found'
    }));
    const kill = vi.fn(async () => undefined);
    const onSpawnError = vi.fn();

    (window as TestWindow).api = {
      terminal: {
        onDataReady: vi.fn(async () => vi.fn()),
        onExitReady: vi.fn(async () => vi.fn()),
        onSessionIdReady: vi.fn(async () => vi.fn()),
        onData: vi.fn(() => vi.fn()),
        onExit: vi.fn(() => vi.fn()),
        onSessionId: vi.fn(() => vi.fn()),
        create,
        write: vi.fn(async () => undefined),
        resize: vi.fn(async () => undefined),
        kill
      }
    };

    const ptyIdRef = makeRef<string | null>(null);

    const { unmount } = renderHook(() =>
      useXtermBind({
        cwd: '/tmp/work',
        command: 'nonexistent-cli',
        termRef: makeRef<Terminal | null>(term),
        fitRef: makeRef<FitAddon | null>(fit),
        snapRef: makeRef<PtySpawnSnapshot>({}),
        callbacksRef: makeRef<PtySessionCallbacks>({ onSpawnError }),
        ptyIdRef,
        disposedRef: makeRef(false),
        observeChunk: vi.fn(),
        unscaledFit: false
      })
    );

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    // spawn 失敗時は ptyIdRef が空のまま、onSpawnError が error 文字列で呼ばれる。
    await waitFor(() => expect(onSpawnError).toHaveBeenCalledTimes(1));
    expect(onSpawnError).toHaveBeenCalledWith('spawn failed: command not found');
    expect(ptyIdRef.current).toBeNull();

    await act(async () => {
      unmount();
      await Promise.resolve();
    });
    // ptyId を持っていないので kill は呼ばれない (orphan kill 防止)。
    expect(kill).not.toHaveBeenCalled();
  });

  it('spawnEnabled=false では PTY 起動を延期し、true になった時点で起動する', async () => {
    const term = makeTerminal();
    const fit = { fit: vi.fn() } as unknown as FitAddon;
    const create = vi.fn(async (opts: { id?: string }) => ({
      ok: true,
      id: opts.id ?? 'pty-test-deferred'
    }));
    const kill = vi.fn(async () => undefined);

    (window as TestWindow).api = {
      terminal: {
        onDataReady: vi.fn(async () => vi.fn()),
        onExitReady: vi.fn(async () => vi.fn()),
        onSessionIdReady: vi.fn(async () => vi.fn()),
        onData: vi.fn(() => vi.fn()),
        onExit: vi.fn(() => vi.fn()),
        onSessionId: vi.fn(() => vi.fn()),
        create,
        write: vi.fn(async () => undefined),
        resize: vi.fn(async () => undefined),
        kill
      }
    };

    const ptyIdRef = makeRef<string | null>(null);
    const termRef = makeRef<Terminal | null>(term);
    const fitRef = makeRef<FitAddon | null>(fit);
    const snapRef = makeRef<PtySpawnSnapshot>({});
    const callbacksRef = makeRef<PtySessionCallbacks>({});
    const disposedRef = makeRef(false);
    const observeChunk = vi.fn();

    const { rerender, unmount } = renderHook(
      ({ enabled }) =>
        useXtermBind({
          cwd: '/tmp/work',
          command: 'claude',
          spawnEnabled: enabled,
          termRef,
          fitRef,
          snapRef,
          callbacksRef,
          ptyIdRef,
          disposedRef,
          observeChunk,
          unscaledFit: false
        }),
      { initialProps: { enabled: false } }
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(create).not.toHaveBeenCalled();

    await act(async () => {
      rerender({ enabled: true });
      await Promise.resolve();
    });
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const spawnedId = create.mock.calls[0][0].id as string;
    await waitFor(() => expect(ptyIdRef.current).toBe(spawnedId));

    await act(async () => {
      rerender({ enabled: false });
      await Promise.resolve();
    });
    expect(kill).not.toHaveBeenCalled();

    await act(async () => {
      unmount();
      await Promise.resolve();
    });
    expect(kill).toHaveBeenCalledWith(spawnedId);
  });
});

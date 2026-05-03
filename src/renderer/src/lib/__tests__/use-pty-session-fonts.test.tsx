import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MutableRefObject } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { usePtySession } from '../use-pty-session';
import type { PtySessionCallbacks, PtySpawnSnapshot } from '../use-pty-session';

type TestWindow = Window &
  typeof globalThis & {
    api?: unknown;
  };

type TestTerminal = Terminal & {
  textarea: HTMLTextAreaElement;
};

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeRef<T>(current: T): MutableRefObject<T> {
  return { current };
}

function makeTerminal(cols = 80, rows = 24): TestTerminal {
  const term = {
    cols,
    rows,
    textarea: document.createElement('textarea'),
    write: vi.fn(),
    writeln: vi.fn(),
    resize: vi.fn((nextCols: number, nextRows: number) => {
      term.cols = nextCols;
      term.rows = nextRows;
    }),
    refresh: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() }))
  } as unknown as TestTerminal;
  return term;
}

describe('usePtySession font readiness', () => {
  let originalApi: unknown;
  let originalFontsDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalApi = (window as TestWindow).api;
    originalFontsDescriptor = Object.getOwnPropertyDescriptor(document, 'fonts');
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

  it('waits for document.fonts.ready before IDE-mode initial fit and terminal create', async () => {
    const fontsReady = deferred();
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: fontsReady.promise } as Partial<FontFaceSet>
    });

    const term = makeTerminal();
    const fit = {
      fit: vi.fn(() => {
        term.cols = 120;
        term.rows = 36;
      })
    } as unknown as FitAddon;
    const create = vi.fn(async (opts: { id?: string }) => ({
      ok: true,
      id: opts.id ?? 'pty-fonts'
    }));

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
        kill: vi.fn(async () => undefined)
      }
    };

    const lastScheduledRef = makeRef<{ cols: number; rows: number } | null>(null);

    renderHook(() =>
      usePtySession({
        cwd: 'C:/workspace',
        command: 'claude',
        termRef: makeRef<Terminal | null>(term),
        fitRef: makeRef<FitAddon | null>(fit),
        snapRef: makeRef<PtySpawnSnapshot>({}),
        callbacksRef: makeRef<PtySessionCallbacks>({}),
        ptyIdRef: makeRef<string | null>(null),
        disposedRef: makeRef(false),
        observeChunk: vi.fn(),
        unscaledFit: false,
        lastScheduledRef
      })
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fit.fit).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();

    await act(async () => {
      fontsReady.resolve();
      await fontsReady.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(fit.fit).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({ cols: 120, rows: 36 });
    expect(lastScheduledRef.current).toEqual({ cols: 120, rows: 36 });
  });
});

/**
 * Issue #503 Fix 1: 初回 spawn 経路で xterm runtime cell を Canvas 2D fallback より優先する。
 *
 * 旧実装は `use-xterm-bind.ts` の loadInitialMetrics 内 (unscaledFit 経路) で
 * `getCellSizeRef.current?.()` (= measureCellSize ベースの Canvas 2D 計測) しか
 * 使っておらず、xterm 自身の CharSizeService が保持する実 cell px とズレていた。
 * これにより初回 spawn 時に term.resize(cols, rows) に渡される cols が xterm 内部 cellW と
 * 食い違い、最初の数フレームで右端の glyph がカラム被りを起こして描画が崩れた
 * (Canvas モードの横方向の文字滲み)。
 *
 * Fix 1 後は use-fit-to-container と同じ runtime-first 優先順序になり、cellW が xterm
 * 内部 cellW と一致する。本テストは:
 *   - getXtermRuntimeCellSize が有効値を返したら runtime cell ベースで cols/rows が決まる
 *   - getXtermRuntimeCellSize が null を返したら fallback (measureCellSize) で決まる
 * の両ケースを term.resize の引数で固定する。
 *
 * スタイル参考: ./unscaled-fit-invariant.test.ts (純関数中心) と
 *               ../hooks/__tests__/use-xterm-bind.test.tsx (hook spawn 経路)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';

// vi.mock は import 文よりも先に hoist される。getXtermRuntimeCellSize の戻り値を
// テストごとに差し替えられるよう、トップレベルで spy を定義する。
const getXtermRuntimeCellSizeMock = vi.fn();
vi.mock('../get-xterm-runtime-cell-size', () => ({
  getXtermRuntimeCellSize: (...args: unknown[]) => getXtermRuntimeCellSizeMock(...args)
}));

import {
  useXtermBind,
  type PtySessionCallbacks,
  type PtySpawnSnapshot
} from '../hooks/use-xterm-bind';
import type { CellSize } from '../measure-cell-size';

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

/**
 * jsdom の HTMLDivElement.clientWidth / clientHeight は layout を持たないと 0 を返す。
 * useXtermBind の loadInitialMetrics は container.clientWidth / clientHeight を読んで
 * computeUnscaledGrid に渡すため、テストでは Object.defineProperty で値を固定する。
 */
function makeContainerWithSize(width: number, height: number): HTMLDivElement {
  const div = document.createElement('div');
  Object.defineProperty(div, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(div, 'clientHeight', { value: height, configurable: true });
  return div;
}

function setupTerminalApi(): {
  create: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(async (opts: { id?: string }) => ({
    ok: true,
    id: opts.id ?? 'pty-test-runtime-cell'
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
  return { create, kill };
}

describe('useXtermBind: 初回 spawn の runtime cell 優先 (Issue #503 Fix 1)', () => {
  let originalApi: unknown;
  let originalFontsDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalApi = (window as TestWindow).api;
    originalFontsDescriptor = Object.getOwnPropertyDescriptor(document, 'fonts');
    // fonts.ready を即時 resolve させて loadInitialMetrics の 300ms timeout 経路を回避。
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: Promise.resolve() } as Partial<FontFaceSet>
    });
    getXtermRuntimeCellSizeMock.mockReset();
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

  it('runtime cell が有効値を返すなら term.resize は runtime cellW/cellH ベースで呼ばれる', async () => {
    // runtime cell: cellW=10, cellH=20 → cols=floor(800/10)=80, rows=round(600/20)=30
    // fallback (measureCellSize) は cellW=8, cellH=18 で別値 → 採用されないことを確認。
    getXtermRuntimeCellSizeMock.mockReturnValue({ cellW: 10, cellH: 20 });
    const fallbackCell: CellSize = { cellW: 8, cellH: 18, fallback: false };
    const getCellSize = vi.fn((): CellSize => fallbackCell);

    const term = makeTerminal();
    const fit = { fit: vi.fn() } as unknown as FitAddon;
    const container = makeContainerWithSize(800, 600);
    const containerRef = { current: container };
    const { create } = setupTerminalApi();

    const ptyIdRef = makeRef<string | null>(null);

    const { unmount } = renderHook(() =>
      useXtermBind({
        cwd: '/tmp/work',
        command: 'claude',
        termRef: makeRef<Terminal | null>(term),
        fitRef: makeRef<FitAddon | null>(fit),
        snapRef: makeRef<PtySpawnSnapshot>({}),
        callbacksRef: makeRef<PtySessionCallbacks>({}),
        ptyIdRef,
        disposedRef: makeRef(false),
        observeChunk: vi.fn(),
        unscaledFit: true,
        getCellSize,
        containerRef
      })
    );

    // loadInitialMetrics → term.resize → terminal.create の順で進むので、create を待つ。
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));

    // runtime cell ベース: cols = floor(800/10) = 80, rows = round(600/20) = 30
    expect(term.resize).toHaveBeenCalledWith(80, 30);
    // fallback の getCellSize は呼ばれてもよい (`?? null` で評価されるため) が、
    // 採用されていない (= cellW=8 ベースの 100 cols が渡されていない) ことだけは保証する。
    expect(term.resize).not.toHaveBeenCalledWith(100, expect.any(Number));

    // create に渡される cols/rows も runtime cell ベース。
    const createArg = (create.mock.calls[0]?.[0] ?? {}) as { cols?: number; rows?: number };
    expect(createArg.cols).toBe(80);
    expect(createArg.rows).toBe(30);

    await act(async () => {
      unmount();
      await Promise.resolve();
    });
  });

  it('runtime cell が null を返したときは fallback (measureCellSize) cellW/cellH で resize される', async () => {
    // runtime null → fallback の cellW=8, cellH=18 が使われる
    // → cols=floor(800/8)=100, rows=round(600/18)=33
    getXtermRuntimeCellSizeMock.mockReturnValue(null);
    const fallbackCell: CellSize = { cellW: 8, cellH: 18, fallback: false };
    const getCellSize = vi.fn((): CellSize => fallbackCell);

    const term = makeTerminal();
    const fit = { fit: vi.fn() } as unknown as FitAddon;
    const container = makeContainerWithSize(800, 600);
    const containerRef = { current: container };
    const { create } = setupTerminalApi();

    const ptyIdRef = makeRef<string | null>(null);

    const { unmount } = renderHook(() =>
      useXtermBind({
        cwd: '/tmp/work',
        command: 'claude',
        termRef: makeRef<Terminal | null>(term),
        fitRef: makeRef<FitAddon | null>(fit),
        snapRef: makeRef<PtySpawnSnapshot>({}),
        callbacksRef: makeRef<PtySessionCallbacks>({}),
        ptyIdRef,
        disposedRef: makeRef(false),
        observeChunk: vi.fn(),
        unscaledFit: true,
        getCellSize,
        containerRef
      })
    );

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));

    // fallback cellW=8 → cols=100, fallback cellH=18 → rows=33
    expect(term.resize).toHaveBeenCalledWith(100, 33);
    expect(getCellSize).toHaveBeenCalled();

    const createArg = (create.mock.calls[0]?.[0] ?? {}) as { cols?: number; rows?: number };
    expect(createArg.cols).toBe(100);
    expect(createArg.rows).toBe(33);

    await act(async () => {
      unmount();
      await Promise.resolve();
    });
  });
});

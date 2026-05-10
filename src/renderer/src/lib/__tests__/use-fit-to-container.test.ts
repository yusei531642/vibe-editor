/**
 * Issue #665: Canvas モードで Claude セッションを動かすと描画がカクつく問題のテスト。
 *
 * 主因: `useFitToContainer.refit()` が zoom 購読 callback で毎回起動されるが、
 *   `container.clientWidth/Height` は transform: scale(zoom) の影響を受けない論理 px のため
 *   grid (cols/rows) は zoom 単独では変わらない。にもかかわらず従来は `term.resize()` +
 *   `term.refresh(0, term.rows-1)` を毎回叩いていたため、Claude が長文出力中の Canvas
 *   ターミナルで xterm の DOM 全行が再ラスタライズされフレーム落ちしていた。
 *
 * Fix: refit が一度 grid を term に適用した値 (`lastAppliedGridRef`) を覚え、
 *   次回 refit で同じ grid なら local の `term.resize()` / `term.refresh()` を skip する。
 *
 * 本テストは hook 単体で:
 *   - 初回 refit (初期 grid 適用) で `term.resize` / `term.refresh` が呼ばれる
 *   - zoom 経由で再 refit が来ても grid が同じなら `term.refresh` が追加で呼ばれない
 *   - container サイズ変化で grid が変わったら通常パスで `term.refresh` が再度走る
 * を機械的に保証する。
 *
 * スタイル参考: ./canvas-fit-runtime-cell.test.ts (use-xterm-bind 経路) と
 *               ./unscaled-fit-invariant.test.ts (純関数中心)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import type { MutableRefObject, RefObject } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { CellSize } from '../measure-cell-size';

// getXtermRuntimeCellSize は xterm 内部 _core を読む helper。jsdom では runtime cell が
// 取れないので null を返してもらい、fallback (getCellSize) を使う経路に乗せる。
const getXtermRuntimeCellSizeMock = vi.fn((): CellSize | null => null);
vi.mock('../get-xterm-runtime-cell-size', () => ({
  getXtermRuntimeCellSize: (...args: unknown[]) => getXtermRuntimeCellSizeMock(...args)
}));

import { useFitToContainer } from '../use-fit-to-container';

type TestWindow = Window &
  typeof globalThis & {
    api?: unknown;
  };

function makeRef<T>(current: T): MutableRefObject<T> {
  return { current };
}

/**
 * テスト用の Terminal モック。`term.resize(cols, rows)` 呼出時に内部 cols/rows を更新する。
 * useFitToContainer の Canvas (unscaled) 経路では cols/rows を直接 grid に揃える挙動。
 */
function freshTerminal(initialCols = 80, initialRows = 24): Terminal {
  const t = {
    cols: initialCols,
    rows: initialRows,
    refresh: vi.fn(),
    focus: vi.fn(),
    resize: vi.fn()
  } as unknown as Terminal & { cols: number; rows: number };
  (t.resize as ReturnType<typeof vi.fn>).mockImplementation((cols: number, rows: number) => {
    (t as unknown as { cols: number; rows: number }).cols = cols;
    (t as unknown as { cols: number; rows: number }).rows = rows;
  });
  return t;
}

/**
 * Helper: container.clientWidth / clientHeight を可変で持つ HTMLDivElement を作る。
 * jsdom はレイアウトを持たないので Object.defineProperty で値を埋め込み、後から差し替え可能にする。
 */
function makeResizableContainer(
  initialWidth: number,
  initialHeight: number
): {
  el: HTMLDivElement;
  setSize: (w: number, h: number) => void;
} {
  let w = initialWidth;
  let h = initialHeight;
  const div = document.createElement('div');
  Object.defineProperty(div, 'clientWidth', { configurable: true, get: () => w });
  Object.defineProperty(div, 'clientHeight', { configurable: true, get: () => h });
  return {
    el: div,
    setSize: (nw: number, nh: number) => {
      w = nw;
      h = nh;
    }
  };
}

function setupTerminalApi(): { resize: ReturnType<typeof vi.fn> } {
  const resize = vi.fn(async () => undefined);
  (window as TestWindow).api = {
    terminal: {
      resize
    }
  };
  return { resize };
}

describe('useFitToContainer: zoom 単独 refit で xterm 全行 refresh を skip (Issue #665)', () => {
  let originalApi: unknown;

  beforeEach(() => {
    originalApi = (window as TestWindow).api;
    vi.useFakeTimers();
    getXtermRuntimeCellSizeMock.mockReturnValue(null);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    if (originalApi === undefined) {
      delete (window as TestWindow).api;
    } else {
      (window as TestWindow).api = originalApi;
    }
    vi.restoreAllMocks();
  });

  it('zoom 経由で再 refit されても grid が同じなら term.refresh / term.resize は再実行されない', () => {
    const t = freshTerminal();
    const fit = { fit: vi.fn() } as unknown as FitAddon;
    const container = makeResizableContainer(800, 600);
    const containerRef: RefObject<HTMLDivElement> = { current: container.el };
    const cellSize: CellSize = { cellW: 8, cellH: 18, fallback: false };
    const getCellSize = vi.fn((): CellSize => cellSize);
    setupTerminalApi();

    let zoomCb: (() => void) | null = null;
    const zoomSubscribe = vi.fn((cb: () => void) => {
      zoomCb = cb;
      return () => {
        zoomCb = null;
      };
    });

    renderHook(() =>
      useFitToContainer({
        containerRef,
        termRef: makeRef<Terminal | null>(t),
        fitRef: makeRef<FitAddon | null>(fit),
        ptyIdRef: makeRef<string | null>('pty-test'),
        visible: true,
        refitTriggers: [],
        unscaledFit: true,
        getCellSize,
        zoomSubscribe,
        getZoom: () => 1.0
      })
    );

    // visible=true effect は VISIBLE_FIT_DELAY_MS=30ms 後に refit する。
    // refitTriggers の effect は mount 即時に refit する (deps array が [] のため)。
    // 両方を消化するため十分な時間を進める。
    vi.advanceTimersByTime(60);

    // この時点で初回 grid (cols=floor(800/8)=100, rows=round(600/18)=33) が適用されているはず。
    expect(t.resize).toHaveBeenCalledWith(100, 33);
    const initialResizeCalls = (t.resize as ReturnType<typeof vi.fn>).mock.calls.length;
    const initialRefreshCalls = (t.refresh as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(initialResizeCalls).toBeGreaterThanOrEqual(1);
    expect(initialRefreshCalls).toBeGreaterThanOrEqual(1);

    // zoom 単独変化 (= container サイズ不変 = grid 不変) で再 refit を発火
    expect(zoomCb).not.toBeNull();
    zoomCb!();
    // ZOOM_DEBOUNCE_MS=100 を進めて refit を実行させる
    vi.advanceTimersByTime(120);

    // grid 不変なので追加の term.resize / term.refresh は走らない
    expect((t.resize as ReturnType<typeof vi.fn>).mock.calls.length).toBe(initialResizeCalls);
    expect((t.refresh as ReturnType<typeof vi.fn>).mock.calls.length).toBe(initialRefreshCalls);

    // 連続 zoom 操作中も skip され続ける
    zoomCb!();
    vi.advanceTimersByTime(120);
    zoomCb!();
    vi.advanceTimersByTime(120);
    expect((t.resize as ReturnType<typeof vi.fn>).mock.calls.length).toBe(initialResizeCalls);
    expect((t.refresh as ReturnType<typeof vi.fn>).mock.calls.length).toBe(initialRefreshCalls);
  });

  it('container サイズが変わって grid が変わったときは通常パスで term.refresh が再度走る', () => {
    const t = freshTerminal();
    const fit = { fit: vi.fn() } as unknown as FitAddon;
    const container = makeResizableContainer(800, 600);
    const containerRef: RefObject<HTMLDivElement> = { current: container.el };
    const cellSize: CellSize = { cellW: 8, cellH: 18, fallback: false };
    const getCellSize = vi.fn((): CellSize => cellSize);
    setupTerminalApi();

    let zoomCb: (() => void) | null = null;
    const zoomSubscribe = vi.fn((cb: () => void) => {
      zoomCb = cb;
      return () => {
        zoomCb = null;
      };
    });

    renderHook(() =>
      useFitToContainer({
        containerRef,
        termRef: makeRef<Terminal | null>(t),
        fitRef: makeRef<FitAddon | null>(fit),
        ptyIdRef: makeRef<string | null>('pty-test'),
        visible: true,
        refitTriggers: [],
        unscaledFit: true,
        getCellSize,
        zoomSubscribe,
        getZoom: () => 1.0
      })
    );

    vi.advanceTimersByTime(60);

    // 初回 refit: cols=100, rows=33
    expect(t.resize).toHaveBeenCalledWith(100, 33);
    const baselineRefreshCalls = (t.refresh as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(baselineRefreshCalls).toBeGreaterThanOrEqual(1);

    // grid 不変な再 refit は skip される
    zoomCb!();
    vi.advanceTimersByTime(120);
    expect((t.refresh as ReturnType<typeof vi.fn>).mock.calls.length).toBe(baselineRefreshCalls);

    // container を実際に拡大 (cols/rows が変わる) → 次の refit で通常パスを通る
    container.setSize(1200, 600);
    // ResizeObserver は jsdom で発火しないため、zoom 購読側から refit を再発火させて
    // 「grid が変わった経路」を観測する (refit() の重複起動でも同等の経路)。
    zoomCb!();
    vi.advanceTimersByTime(120);

    // grid が cols=150 (= floor(1200/8)) に変わるので term.resize / term.refresh が再実行される
    expect(t.resize).toHaveBeenLastCalledWith(150, 33);
    expect((t.refresh as ReturnType<typeof vi.fn>).mock.calls.length).toBe(baselineRefreshCalls + 1);
  });
});

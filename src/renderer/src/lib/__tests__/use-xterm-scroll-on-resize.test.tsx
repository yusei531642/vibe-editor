/**
 * useXtermScrollToBottomOnResize の最小動作テスト。
 *
 * jsdom の ResizeObserver は no-op polyfill (test-setup.ts) のため、
 * 「resize でコールバックが発火する」経路はテストできない。
 * 代わりに以下の 2 点を検証する:
 *   1. 初回 mount 後の 100ms 遅延 timer 経由で `.xterm-viewport` の
 *      scrollTop が scrollHeight に補正されること
 *   2. `.xterm-viewport` が存在しないコンテナでも例外を投げないこと
 */
import { useRef } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { useXtermScrollToBottomOnResize } from '../use-xterm-scroll-on-resize';

// rAF を即時実行に置換して timer/rAF 連携をテストしやすくする。
const originalRaf = globalThis.requestAnimationFrame;
const originalCaf = globalThis.cancelAnimationFrame;

beforeEach(() => {
  vi.useFakeTimers();
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    // 即時に呼ぶ。戻り値は number 互換であれば良い。
    cb(0);
    return 1;
  }) as unknown as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => undefined) as typeof cancelAnimationFrame;
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.requestAnimationFrame = originalRaf;
  globalThis.cancelAnimationFrame = originalCaf;
  cleanup();
});

function HookHarness({
  withViewport
}: {
  withViewport: boolean;
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  useXtermScrollToBottomOnResize(ref);
  return (
    <div ref={ref} data-testid="host">
      {withViewport ? (
        <div className="xterm-viewport" data-testid="viewport" />
      ) : null}
    </div>
  );
}

describe('useXtermScrollToBottomOnResize', () => {
  it('初回 mount 後の遅延 timer で scrollTop が scrollHeight に補正される', () => {
    const { getByTestId } = render(<HookHarness withViewport={true} />);
    const viewport = getByTestId('viewport') as HTMLDivElement;

    // jsdom は scrollHeight を 0 で返すため、テスト用に scrollHeight を上書きする。
    Object.defineProperty(viewport, 'scrollHeight', { value: 5000, configurable: true });
    // scrollTop は意図的に途中の値で残しておく。
    viewport.scrollTop = 1234;

    // 100ms timer を進める
    vi.advanceTimersByTime(150);

    expect(viewport.scrollTop).toBe(5000);
  });

  it('.xterm-viewport が無いコンテナでも例外を投げない', () => {
    expect(() => {
      render(<HookHarness withViewport={false} />);
      vi.advanceTimersByTime(150);
    }).not.toThrow();
  });
});

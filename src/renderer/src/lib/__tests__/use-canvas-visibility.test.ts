/**
 * Issue #578: `useCanvasVisibility` の挙動を固定する。
 *
 * 検証範囲:
 *   - `document.visibilityState` の変化が `isCanvasVisibleNow()` に反映される
 *   - `getHiddenSinceMs()` が hidden 開始時刻を保持し visible 復帰で null に戻る
 *   - `subscribeOnVisible` が hidden→visible 遷移時のみ発火する (edge trigger)
 *   - 連続して visible のまま `subscribeOnVisible` を発火させない
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetCanvasVisibilityForTests,
  getHiddenSinceMs,
  isCanvasVisibleNow,
  subscribeOnVisible
} from '../use-canvas-visibility';

function setVisibilityState(value: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => value
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

function fireFocus(): void {
  window.dispatchEvent(new Event('focus'));
}

function fireBlur(): void {
  window.dispatchEvent(new Event('blur'));
}

describe('useCanvasVisibility', () => {
  beforeEach(() => {
    __resetCanvasVisibilityForTests();
    setVisibilityState('visible');
    // jsdom では document.hasFocus は true を返す。明示してテスト外要因を排除。
    Object.defineProperty(document, 'hasFocus', {
      configurable: true,
      value: () => true
    });
  });

  afterEach(() => {
    __resetCanvasVisibilityForTests();
    vi.restoreAllMocks();
  });

  it('visible 時は isCanvasVisibleNow=true、hiddenSinceMs=null', () => {
    expect(isCanvasVisibleNow()).toBe(true);
    expect(getHiddenSinceMs()).toBeNull();
  });

  it('hidden 遷移で hiddenSinceMs に Date.now() を記録し isCanvasVisibleNow=false になる', () => {
    isCanvasVisibleNow(); // ensureInit
    const before = Date.now();
    setVisibilityState('hidden');
    expect(isCanvasVisibleNow()).toBe(false);
    const since = getHiddenSinceMs();
    expect(since).not.toBeNull();
    expect(since!).toBeGreaterThanOrEqual(before);
  });

  it('window blur でも hidden になる (Tauri webview がフォーカス外)', () => {
    isCanvasVisibleNow();
    fireBlur();
    expect(isCanvasVisibleNow()).toBe(false);
    expect(getHiddenSinceMs()).not.toBeNull();
  });

  it('visible に戻ると hiddenSinceMs=null に復帰する', () => {
    isCanvasVisibleNow();
    setVisibilityState('hidden');
    expect(getHiddenSinceMs()).not.toBeNull();
    setVisibilityState('visible');
    expect(isCanvasVisibleNow()).toBe(true);
    expect(getHiddenSinceMs()).toBeNull();
  });

  it('subscribeOnVisible は hidden→visible 遷移時のみ発火する (edge trigger)', () => {
    const cb = vi.fn();
    const unsub = subscribeOnVisible(cb);

    // visible のまま focus/blur が来ても発火しない
    fireFocus();
    expect(cb).not.toHaveBeenCalled();

    setVisibilityState('hidden');
    expect(cb).not.toHaveBeenCalled(); // hidden 遷移では発火しない

    setVisibilityState('visible');
    expect(cb).toHaveBeenCalledTimes(1);

    // 連続して visible のまま focus が来ても再発火しない
    fireFocus();
    expect(cb).toHaveBeenCalledTimes(1);

    // 再度 hidden → visible で再発火
    setVisibilityState('hidden');
    setVisibilityState('visible');
    expect(cb).toHaveBeenCalledTimes(2);

    unsub();
    setVisibilityState('hidden');
    setVisibilityState('visible');
    expect(cb).toHaveBeenCalledTimes(2); // unsub 後は発火しない
  });

  it('複数 subscriber が独立して発火する', () => {
    const a = vi.fn();
    const b = vi.fn();
    subscribeOnVisible(a);
    subscribeOnVisible(b);

    setVisibilityState('hidden');
    setVisibilityState('visible');

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});

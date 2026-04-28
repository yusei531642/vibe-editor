import '@testing-library/jest-dom/vitest';

// jsdom には ResizeObserver が無い。Canvas/xterm 系のフックが
// マウント直後に observe を呼ぶため、最低限の no-op polyfill を入れる。
class ResizeObserverPolyfill {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverPolyfill }).ResizeObserver =
    ResizeObserverPolyfill;
}

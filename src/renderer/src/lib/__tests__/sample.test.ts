import { describe, it, expect } from 'vitest';

describe('test infrastructure smoke', () => {
  it('basic assertion works', () => {
    expect(1 + 1).toBe(2);
  });

  it('jsdom environment is available', () => {
    expect(typeof window).toBe('object');
    expect(typeof document).toBe('object');
  });

  it('ResizeObserver polyfill is installed', () => {
    expect(typeof globalThis.ResizeObserver).toBe('function');
    const ro = new ResizeObserver(() => undefined);
    expect(ro.observe).toBeTypeOf('function');
    expect(ro.disconnect).toBeTypeOf('function');
  });
});

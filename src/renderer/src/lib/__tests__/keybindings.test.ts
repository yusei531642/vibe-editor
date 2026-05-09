/**
 * useKeybinding gate test (Issue #613).
 *
 * <CanvasLayout> は IDE モードでも常時 mount されているため、Canvas.tsx 内の
 * useKeybinding が IDE 中も capture phase で window keydown を奪う問題があった。
 * `enabled` 引数で gate されたとき addEventListener が走らない (= handler が呼ばれず、
 * 標準のショートカットが奪われない) ことを保証する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { KEYS, useKeybinding } from '../keybindings';

function dispatchKey(key: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}): void {
  const ev = new KeyboardEvent('keydown', {
    key,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
    metaKey: mods.meta ?? false,
    bubbles: true,
    cancelable: true
  });
  window.dispatchEvent(ev);
}

describe('useKeybinding (Issue #613 gate)', () => {
  beforeEach(() => {
    // jsdom default body の focus は <body> なので isInTextEditing は false
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('enabled=true (default) なら handler が発火する', () => {
    const handler = vi.fn();
    renderHook(() => useKeybinding(KEYS.quickNav, handler));
    dispatchKey('k', { ctrl: true, shift: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('enabled=false なら addEventListener も走らず handler は発火しない', () => {
    const handler = vi.fn();
    renderHook(() => useKeybinding(KEYS.quickNav, handler, false));
    dispatchKey('k', { ctrl: true, shift: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it('enabled=false で Ctrl+Shift+I を押しても Inspector handler が発火しない (DevTools 解放を保証)', () => {
    const handler = vi.fn();
    renderHook(() => useKeybinding(KEYS.toggleIde, handler, false));
    dispatchKey('i', { ctrl: true, shift: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it('enabled=false で Ctrl+Shift+N を 10 回押しても handler は 1 度も呼ばれない (空 agent カード regression 防止)', () => {
    const handler = vi.fn();
    renderHook(() => useKeybinding(KEYS.newTerminal, handler, false));
    for (let i = 0; i < 10; i++) {
      dispatchKey('n', { ctrl: true, shift: true });
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('rerender で enabled が false → true に変わると、その後の keydown では発火する', () => {
    const handler = vi.fn();
    const { rerender } = renderHook(({ enabled }) => useKeybinding(KEYS.quickNav, handler, enabled), {
      initialProps: { enabled: false }
    });
    dispatchKey('k', { ctrl: true, shift: true });
    expect(handler).not.toHaveBeenCalled();
    rerender({ enabled: true });
    dispatchKey('k', { ctrl: true, shift: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('rerender で enabled が true → false に変わると、それ以降は発火しない', () => {
    const handler = vi.fn();
    const { rerender } = renderHook(({ enabled }) => useKeybinding(KEYS.quickNav, handler, enabled), {
      initialProps: { enabled: true }
    });
    dispatchKey('k', { ctrl: true, shift: true });
    expect(handler).toHaveBeenCalledTimes(1);
    rerender({ enabled: false });
    dispatchKey('k', { ctrl: true, shift: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('別キー (Ctrl+K だけ) では Ctrl+Shift+K の handler は発火しない (modifier 完全一致を保証)', () => {
    const handler = vi.fn();
    renderHook(() => useKeybinding(KEYS.quickNav, handler));
    dispatchKey('k', { ctrl: true, shift: false });
    expect(handler).not.toHaveBeenCalled();
  });
});

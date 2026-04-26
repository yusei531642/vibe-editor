/**
 * keybindings.ts — Phase 4 で導入するキーボードショートカット集約。
 *
 * Phase 4 では Canvas モード固有の binding のみ扱う:
 *   - Ctrl+Shift+K  → Quick Nav (agent/card 検索)
 *   - Ctrl+Shift+I  → IDE モードへ戻る
 *   - Ctrl+Shift+M  → Canvas モードへ切替
 *   - Ctrl+Shift+N  → 新しい Terminal Card
 *
 * Phase 5 以降で IDE 側 (CommandPalette など) も移行。
 */
import { useEffect } from 'react';

export interface KeyDef {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}

function matches(e: KeyboardEvent, def: KeyDef): boolean {
  return (
    e.key.toLowerCase() === def.key.toLowerCase() &&
    !!def.ctrl === e.ctrlKey &&
    !!def.shift === e.shiftKey &&
    !!def.alt === e.altKey &&
    !!def.meta === e.metaKey
  );
}

/**
 * Issue #177: テキスト入力中にショートカットが奪われると、Notes / Settings /
 * CommandPalette の入力欄で「うっかり起動」が頻発していた。input / textarea /
 * contenteditable に focus があるときはショートカットを発動させない。
 *
 * xterm.js は内部の hidden textarea に focus を当てるため、`.xterm` 配下の
 * textarea は引き続き素通しさせたい。明示的に [data-keybind-passthrough] と
 * `.xterm` 配下の場合は除外して扱う。
 */
function isInTextEditing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest('[data-keybind-passthrough], .xterm')) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type.toLowerCase();
    // checkbox / radio / button / file 等はテキスト入力ではないので除外
    const passthroughTypes = ['checkbox', 'radio', 'button', 'submit', 'reset', 'file'];
    return !passthroughTypes.includes(type);
  }
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return false;
}

export function useKeybinding(def: KeyDef, handler: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent): void => {
      if (!matches(e, def)) return;
      if (isInTextEditing(e.target)) return;
      e.preventDefault();
      handler();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [def.key, def.ctrl, def.shift, def.alt, def.meta, enabled, handler]);
}

export const KEYS = {
  quickNav: { key: 'k', ctrl: true, shift: true } satisfies KeyDef,
  toggleIde: { key: 'i', ctrl: true, shift: true } satisfies KeyDef,
  toggleCanvas: { key: 'm', ctrl: true, shift: true } satisfies KeyDef,
  newTerminal: { key: 'n', ctrl: true, shift: true } satisfies KeyDef
};

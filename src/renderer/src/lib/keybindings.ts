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

export function useKeybinding(def: KeyDef, handler: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent): void => {
      if (matches(e, def)) {
        e.preventDefault();
        handler();
      }
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

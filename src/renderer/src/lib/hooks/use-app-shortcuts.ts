import { useEffect, useRef } from 'react';
import { webviewZoom } from '../webview-zoom';
import { useUiStore } from '../../stores/ui';

export interface UseAppShortcutsOptions {
  /** Phase 1-2 (use-file-tabs) hook 戻り値ブリッジ。 */
  activeTabId: string | null;
  cycleTab: (direction: 1 | -1) => void;
  closeTab: (id: string) => void;
  reopenLastClosed: () => void;
  saveEditorTab: (id: string) => Promise<void>;
}

/**
 * Issue #373 Phase 1-6: グローバルショートカット (Ctrl+Shift+P / Ctrl+, /
 * Ctrl+S / Ctrl+Tab / Ctrl+W / Ctrl+Shift+T / Escape) と Shift+wheel zoom を
 * App.tsx から切り出した hook。
 *
 * 設計:
 * - opts は `optsRef.current = opts` で毎 render 更新し、内部 useEffect の
 *   deps を `[]` で固定する (Phase 1-1 〜 1-5 と同じ流儀)。これにより
 *   listener を 1 度だけ register/unregister する形になり、毎 render の
 *   attach/detach コストを排除する。
 * - 不変式 (絶対に壊さない):
 *   - Issue #38: Ctrl+W で xterm 内にフォーカスがあれば PTY に素通し
 *   - Issue #162: modal open 中は Ctrl+S / Ctrl+Tab / Ctrl+W / Ctrl+Shift+T を
 *     ブロック (Ctrl+Shift+P と Ctrl+, は toggle 用途のため通す)
 *   - keydown は `{ capture: true }` で attach (子の stopPropagation より先に拾う)
 *   - wheel は `{ passive: false }` で attach (preventDefault が効くために必須)
 *   - Escape の優先順位: palette が開いていれば palette、そうでなければ settings
 *
 * Phase 1-9 (AppShell 化) で Ctrl+B (sidebar toggle) や theme cycle を統合する
 * 場合はここに合流させる。
 */
export function useAppShortcuts(opts: UseAppShortcutsOptions): void {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // Shift+ホイールで webview zoom
  // webviewZoom (factor 0.5-3.0) に委譲。Ctrl+=/-/0 と同じ値を共有するので
  // 両方の経路を混ぜて操作しても状態が食い違わない。
  useEffect(() => {
    const handler = (e: WheelEvent): void => {
      if (!e.shiftKey) return;
      e.preventDefault();
      webviewZoom.adjust(e.deltaY > 0 ? -webviewZoom.STEP : webviewZoom.STEP);
    };
    window.addEventListener('wheel', handler, { passive: false });
    return () => window.removeEventListener('wheel', handler);
  }, []);

  // グローバルショートカット
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const o = optsRef.current;
      // Phase 1-8: paletteOpen / settingsOpen は useUiStore で一元管理。
      // handler 起動時に getState() でスナップショットを読む (subscribe 不要)。
      const ui = useUiStore.getState();
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) {
        if (e.key === 'Escape') {
          if (ui.paletteOpen) ui.setPaletteOpen(false);
          else if (ui.settingsOpen) ui.setSettingsOpen(false);
        }
        return;
      }
      // Issue #162: Ctrl+Shift+P (パレット toggle) と Ctrl+, (設定) は modal open 中でも
      // 反応してよい (toggle 用途のため)。それ以外のショートカット (Ctrl+S / Ctrl+Tab /
      // Ctrl+W / Ctrl+Shift+T) は modal/palette open 中はブロックする。
      const modalIsOpen = ui.paletteOpen || ui.settingsOpen;
      if (e.shiftKey && (e.key === 'P' || e.key === 'p')) {
        e.preventDefault();
        e.stopPropagation();
        ui.togglePalette();
        return;
      }
      if (e.key === ',') {
        e.preventDefault();
        ui.setSettingsOpen(true);
        return;
      }
      if (modalIsOpen) {
        // 以降の保存・タブ切替・タブ閉じはブロック
        return;
      }
      if (!e.shiftKey && (e.key === 's' || e.key === 'S')) {
        if (o.activeTabId && o.activeTabId.startsWith('edit:')) {
          e.preventDefault();
          e.stopPropagation();
          void o.saveEditorTab(o.activeTabId);
        }
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        o.cycleTab(e.shiftKey ? -1 : 1);
        return;
      }
      if (e.key === 'w' || e.key === 'W') {
        // Issue #38: フォーカスが xterm (Claude / Codex / シェル) の中にあるときは
        // Ctrl+W を「直前の単語を削除」として PTY に素通しさせる。
        const active = document.activeElement as HTMLElement | null;
        const inTerminal = active?.closest?.('.xterm') !== undefined &&
          active?.closest?.('.xterm') !== null;
        if (!inTerminal && o.activeTabId) {
          e.preventDefault();
          e.stopPropagation();
          o.closeTab(o.activeTabId);
        }
        return;
      }
      if (e.shiftKey && (e.key === 'T' || e.key === 't')) {
        e.preventDefault();
        o.reopenLastClosed();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);
}

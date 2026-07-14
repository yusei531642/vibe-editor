import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex="-1"])';

function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.tabIndex >= 0 && !element.hidden
  );
}

export interface ModalA11y {
  dialogRef: RefObject<HTMLDivElement | null>;
}

/** Issue #1142: nested modal共通の初期focus・focus trap・Escape所有権。 */
export function useModalA11y(onClose: () => void): ModalA11y {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = dialogRef.current;
    (root ? focusableElements(root)[0] ?? root : null)?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      const active = document.activeElement;
      const activeInside = active instanceof Node && root?.contains(active) === true;
      const ownsFocus =
        active === null || active === document.body || activeInside;
      if (!root || !ownsFocus) return;
      if (event.key === 'Escape') {
        if (event.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusables = focusableElements(root);
      if (focusables.length === 0) {
        event.preventDefault();
        root.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!activeInside || active === root || (event.shiftKey && active === first)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  return { dialogRef };
}

export function nestedModalOwnsEscape(): boolean {
  const owner = document.querySelector<HTMLElement>('[data-modal-escape-owner="true"]');
  const active = document.activeElement;
  return owner !== null && (active === null || active === document.body || owner.contains(active));
}

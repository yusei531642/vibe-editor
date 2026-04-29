import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface ContextMenuItem {
  label: string;
  icon?: ReactNode;
  action: () => void;
  disabled?: boolean;
  /** 区切り線を直後に入れるか */
  divider?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

/**
 * 軽量コンテキストメニュー。
 * - 画面外はみ出しを検出して位置補正
 * - 外クリック / Escape でクローズ
 * - アクセント付きホバーで Claude.ai 風
 */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [state, setState] = useState<'open' | 'closed'>('closed');
  // Issue #163: WAI-ARIA menu pattern 準拠。matchable な (= 非 disabled) 項目だけを
  // 矢印キーで巡回させる。
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [focusedIndex, setFocusedIndex] = useState(0);

  // マウント直後にサイズを測って画面外はみ出しを補正
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    let nx = x;
    let ny = y;
    if (nx + rect.width + pad > window.innerWidth) {
      nx = Math.max(pad, window.innerWidth - rect.width - pad);
    }
    if (ny + rect.height + pad > window.innerHeight) {
      ny = Math.max(pad, window.innerHeight - rect.height - pad);
    }
    setPos({ x: nx, y: ny });
  }, [x, y]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setState('open'));
    return () => cancelAnimationFrame(raf);
  }, []);

  // Issue #163: 最初の matchable な項目に自動フォーカス。
  useEffect(() => {
    const firstEnabled = items.findIndex((it) => !it.disabled);
    if (firstEnabled >= 0) {
      setFocusedIndex(firstEnabled);
      // 次フレームで focus (DOM が ready なはず)
      requestAnimationFrame(() => {
        itemRefs.current[firstEnabled]?.focus();
      });
    }
  }, [items]);

  useEffect(() => {
    const handleClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      // Issue #163: WAI-ARIA menu pattern: ArrowUp / ArrowDown / Home / End / Tab で閉じる。
      // disabled をスキップしながら巡回する。
      if (e.key === 'Tab') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        const enabledIdx = items
          .map((it, i) => (it.disabled ? -1 : i))
          .filter((i) => i >= 0);
        if (enabledIdx.length === 0) return;
        let next = focusedIndex;
        if (e.key === 'Home') next = enabledIdx[0];
        else if (e.key === 'End') next = enabledIdx[enabledIdx.length - 1];
        else {
          const cur = enabledIdx.indexOf(focusedIndex);
          const step = e.key === 'ArrowDown' ? 1 : -1;
          const ni = (cur + step + enabledIdx.length) % enabledIdx.length;
          next = enabledIdx[ni];
        }
        setFocusedIndex(next);
        itemRefs.current[next]?.focus();
      }
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose, items, focusedIndex]);

  // Issue #283: 親 (.sidebar など) に backdrop-filter が掛かっていると、
  // それが position: fixed の containing block になってしまい、メニューが
  // sidebar の幅 (272px) に閉じ込められて右側が見切れる。document.body 直下に
  // Portal でレンダーして containing block を viewport に戻す。
  return createPortal(
    <div
      ref={ref}
      className="context-menu"
      data-state={state}
      data-motion="scale"
      style={{ left: pos.x, top: pos.y }}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => (
        <div key={i}>
          <button
            type="button"
            ref={(el) => {
              itemRefs.current[i] = el;
            }}
            className="context-menu__item"
            onClick={() => {
              if (item.disabled) return;
              onClose();
              item.action();
            }}
            onFocus={() => setFocusedIndex(i)}
            tabIndex={focusedIndex === i ? 0 : -1}
            disabled={item.disabled}
            aria-disabled={item.disabled}
            role="menuitem"
          >
            {item.icon && <span className="context-menu__icon">{item.icon}</span>}
            <span className="context-menu__label">{item.label}</span>
          </button>
          {item.divider && <div className="context-menu__divider" />}
        </div>
      ))}
    </div>,
    document.body
  );
}

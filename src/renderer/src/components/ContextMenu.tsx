import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

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
    const handleClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ left: pos.x, top: pos.y }}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => (
        <div key={i}>
          <button
            type="button"
            className="context-menu__item"
            onClick={() => {
              if (item.disabled) return;
              onClose();
              item.action();
            }}
            disabled={item.disabled}
            role="menuitem"
          >
            {item.icon && <span className="context-menu__icon">{item.icon}</span>}
            <span className="context-menu__label">{item.label}</span>
          </button>
          {item.divider && <div className="context-menu__divider" />}
        </div>
      ))}
    </div>
  );
}

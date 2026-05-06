/**
 * MenuBar — Topbar 左側に置く File / View / Help 等の自作メニューバー。
 *
 * 旧 ハンバーガー (`AppMenu`) を撤去してこちらに置き換える。
 * ネイティブ OS メニューに頼らず、CSS + React で完結。
 *
 * 挙動 (Windows / macOS の伝統的メニューバー流):
 *   - メニュー項目をクリック → そのドロップダウンを開く
 *   - 別の項目を hover (どこかが既に開いている場合のみ) → そちらに開け替え
 *   - 外クリック / Esc / 項目選択 → 全閉じ
 */
import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

export interface MenuBarItem {
  /** 親ボタンに表示するラベル ('ファイル' / '表示' 等) */
  label: string;
  /** ドロップダウン本文 (中身は MenuDropdown 子コンポーネントで描画) */
  children: ReactNode;
  /** title 属性 / aria-label */
  hint?: string;
}

export interface MenuBarProps {
  items: MenuBarItem[];
}

export function MenuBar({ items }: MenuBarProps): JSX.Element {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // 外クリック / Esc で閉じる
  useEffect(() => {
    if (openIdx === null) return;
    const onMouseDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpenIdx(null);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpenIdx(null);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [openIdx]);

  return (
    <div className="menubar" ref={rootRef} role="menubar">
      {items.map((item, i) => {
        const open = openIdx === i;
        return (
          <div key={item.label} className="menubar__entry" data-open={open || undefined}>
            <button
              type="button"
              className={`menubar__trigger${open ? ' is-open' : ''}`}
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={open}
              title={item.hint ?? item.label}
              onClick={() => setOpenIdx(open ? null : i)}
              onMouseEnter={() => {
                // 既にどこか開いてるときは hover で切り替え (典型的な menu bar 挙動)
                if (openIdx !== null && openIdx !== i) setOpenIdx(i);
              }}
            >
              <span className="menubar__label">{item.label}</span>
              <ChevronDown size={11} strokeWidth={2} className="menubar__caret" />
            </button>
            {open && (
              <div
                className="menubar__dropdown"
                role="menu"
                onClick={(e) => {
                  // メニュー項目クリック後は閉じる (内側 button が onClick で行動済み)
                  // ただし divider / section-label のクリックでは閉じない
                  const target = e.target as HTMLElement;
                  if (target.closest('button[role="menuitem"]')) {
                    setOpenIdx(null);
                  }
                }}
              >
                {item.children}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** ドロップダウン内の 1 行 (アイコン + ラベル + ショートカット) */
export interface MenuItemProps {
  icon?: ReactNode;
  label: string;
  /** 右端に薄く表示するショートカット文字列 (例: "Ctrl+B") */
  shortcut?: string;
  onClick: () => void;
  disabled?: boolean;
}

export const MenuItem = memo(function MenuItem({
  icon,
  label,
  shortcut,
  onClick,
  disabled
}: MenuItemProps): JSX.Element {
  return (
    <button
      type="button"
      className="menubar__item"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      aria-disabled={disabled}
    >
      <span className="menubar__item-icon">{icon}</span>
      <span className="menubar__item-label">{label}</span>
      {shortcut && <span className="menubar__item-shortcut">{shortcut}</span>}
    </button>
  );
});

/** 区切り線 */
export const MenuDivider = memo(function MenuDivider(): JSX.Element {
  return <div className="menubar__divider" aria-hidden="true" />;
});

/** セクション見出し (例: 「最近開いたプロジェクト」) */
export const MenuSection = memo(function MenuSection({
  label,
  rightSlot
}: {
  label: string;
  rightSlot?: ReactNode;
}): JSX.Element {
  return (
    <div className="menubar__section">
      <span>{label}</span>
      {rightSlot}
    </div>
  );
});

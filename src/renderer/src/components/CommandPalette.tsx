import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search } from 'lucide-react';
import { filterCommands, type Command } from '../lib/commands';
import { useT } from '../lib/i18n';
import { useSpringMount } from '../lib/use-animated-mount';

interface CommandPaletteProps {
  open: boolean;
  commands: Command[];
  onClose: () => void;
}

/**
 * Ctrl+Shift+P で開く統一コマンドパレット。
 * - 入力でファジー検索
 * - 上下キーで選択移動、Enter で実行、Esc で閉じる
 * - クリック可
 */
export function CommandPalette({
  open,
  commands,
  onClose
}: CommandPaletteProps): JSX.Element | null {
  const t = useT();
  const [query, setQuery] = useState<string>('');
  const [selected, setSelected] = useState<number>(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const filtered = useMemo(() => filterCommands(commands, query), [commands, query]);

  // 開いた瞬間に入力フォーカス＋クエリクリア
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelected(0);
      // マウント直後にフォーカスするためミリ秒遅延
      const t = setTimeout(() => inputRef.current?.focus(), 20);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [open]);

  // filtered変化時に selected を範囲内に収める
  useEffect(() => {
    if (selected >= filtered.length) setSelected(Math.max(0, filtered.length - 1));
  }, [filtered.length, selected]);

  // 選択項目をスクロール可視化
  useEffect(() => {
    const el = listRef.current?.children[selected] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const { mounted, dataState, motion } = useSpringMount(open, 160);

  const runSelected = useCallback((): void => {
    const cmd = filtered[selected];
    if (!cmd) return;
    onClose();
    // voidキャスト: async でも同期でも同じ扱い
    void Promise.resolve(cmd.run());
  }, [filtered, selected, onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): void => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelected((i) => Math.min(filtered.length - 1, i + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        runSelected();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    },
    [filtered.length, runSelected, onClose]
  );

  // Issue #180: 旧実装は backdrop onClick={onClose} で閉じていたため、リスト内/入力欄で
  // mousedown → backdrop で mouseup と移動するドラッグ選択 (テキスト選択) でも click が
  // backdrop に届いて閉じていた。
  // mousedown 時点の target が backdrop 自体のときだけ閉じるように変更。
  // (panel 内で mousedown した click は target=panel の子孫になるので閉じない)
  const handleBackdropMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>): void => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  // Hook を全て呼び出した後で早期 return する (rules-of-hooks)。
  // 旧コードは useSpringMount 直後に `if (!mounted) return null` を置いて
  // 後続の useCallback を条件付き呼び出しにしていたため、open 切替で
  // "Rendered more hooks than during the previous render" が発生していた。
  // mounted=false の間は portal を出さないが、useState / useEffect / useCallback
  // は全て呼び終わってから return することで hook 数を render 間で一定に保つ。
  if (!mounted) return null;

  return createPortal(
    <div
      className="cmdp-backdrop"
      data-state={dataState}
      data-motion={motion}
      onMouseDown={handleBackdropMouseDown}
      role="dialog"
      aria-modal="true"
      aria-label={t('palette.ariaLabel')}
    >
      <div
        className="cmdp"
        data-state={dataState}
        data-motion={motion}
      >
        <div className="cmdp__header">
          <div className="cmdp__search">
            <Search size={16} strokeWidth={2} className="cmdp__prompt" />
            <input
              ref={inputRef}
              className="cmdp__input"
              type="text"
              placeholder={t('palette.placeholder')}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelected(0);
              }}
              onKeyDown={handleKeyDown}
              spellCheck={false}
              autoComplete="off"
              role="combobox"
              aria-controls="cmdp-listbox"
              aria-activedescendant={
                filtered[selected] ? `cmdp-option-${filtered[selected].id}` : undefined
              }
              aria-expanded={filtered.length > 0}
            />
          </div>
          <div className="cmdp__meta">
            <span className="cmdp__hint">{t('palette.hint')}</span>
            <span className="cmdp__count">{t('palette.count', { count: filtered.length })}</span>
          </div>
        </div>
        <ul ref={listRef} className="cmdp__list" role="listbox" id="cmdp-listbox">
          {filtered.length === 0 ? (
            <li className="cmdp__empty">{t('palette.empty')}</li>
          ) : (
            filtered.map((cmd, i) => (
              <li
                key={cmd.id}
                id={`cmdp-option-${cmd.id}`}
                className={`cmdp__item ${i === selected ? 'is-selected' : ''}`}
                role="option"
                aria-selected={i === selected}
                onClick={() => {
                  setSelected(i);
                  onClose();
                  void Promise.resolve(cmd.run());
                }}
                onMouseEnter={() => setSelected(i)}
              >
                <span className="cmdp__item-main">
                  <span className="cmdp__category">{cmd.category}</span>
                  <span className="cmdp__title">{cmd.title}</span>
                </span>
                {cmd.subtitle && (
                  <span className="cmdp__subtitle">{cmd.subtitle}</span>
                )}
              </li>
            ))
          )}
        </ul>
      </div>
    </div>,
    document.body
  );
}

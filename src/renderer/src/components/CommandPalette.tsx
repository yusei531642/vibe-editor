import { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { filterCommands, type Command } from '../lib/commands';
import { useAnimatedMount } from '../lib/use-animated-mount';

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

  const { mounted, state } = useAnimatedMount(open, 220);
  if (!mounted) return null;

  const runSelected = (): void => {
    const cmd = filtered[selected];
    if (!cmd) return;
    onClose();
    // voidキャスト: async でも同期でも同じ扱い
    void Promise.resolve(cmd.run());
  };

  const handleKeyDown = (e: React.KeyboardEvent): void => {
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
  };

  return (
    <div
      className="cmdp-backdrop"
      data-state={state}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="コマンドパレット"
    >
      <div className="cmdp" data-state={state} onClick={(e) => e.stopPropagation()}>
        <div className="cmdp__header">
          <Search size={16} strokeWidth={2} className="cmdp__prompt" />
          <input
            ref={inputRef}
            className="cmdp__input"
            type="text"
            placeholder="コマンドを検索…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            onKeyDown={handleKeyDown}
            spellCheck={false}
            autoComplete="off"
          />
          <span className="cmdp__hint">↑↓ で選択 · Enter で実行 · Esc で閉じる</span>
        </div>
        <ul ref={listRef} className="cmdp__list">
          {filtered.length === 0 ? (
            <li className="cmdp__empty">一致するコマンドがありません</li>
          ) : (
            filtered.map((cmd, i) => (
              <li
                key={cmd.id}
                className={`cmdp__item ${i === selected ? 'is-selected' : ''}`}
                onClick={() => {
                  setSelected(i);
                  onClose();
                  void Promise.resolve(cmd.run());
                }}
                onMouseEnter={() => setSelected(i)}
              >
                <span className="cmdp__category">{cmd.category}</span>
                <span className="cmdp__title">{cmd.title}</span>
                {cmd.subtitle && (
                  <span className="cmdp__subtitle">{cmd.subtitle}</span>
                )}
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}

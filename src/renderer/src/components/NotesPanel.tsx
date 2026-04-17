/**
 * NotesPanel — Issue #17
 *
 * ターミナル間 (コンテキストクリア・新規ターミナル等) で
 * 短いメモを受け渡しするための永続テキストエリア。
 * - 入力中も自動保存 (debounce 600ms)
 * - クリップボードにコピー / クリアの簡易操作
 * - 永続化先は AppSettings.notepad
 */
import { useEffect, useRef, useState } from 'react';
import { Copy, Eraser } from 'lucide-react';
import { useSettings } from '../lib/settings-context';
import { useT } from '../lib/i18n';
import { useToast } from '../lib/toast-context';

const SAVE_DEBOUNCE_MS = 600;

export function NotesPanel(): JSX.Element {
  const { settings, update } = useSettings();
  const t = useT();
  const toast = useToast();
  const [draft, setDraft] = useState<string>(settings.notepad ?? '');
  const debounceRef = useRef<number | null>(null);
  const lastSavedRef = useRef<string>(settings.notepad ?? '');

  // 外部 (settings reload など) で notepad が変わったら同期
  useEffect(() => {
    if (settings.notepad !== lastSavedRef.current) {
      setDraft(settings.notepad ?? '');
      lastSavedRef.current = settings.notepad ?? '';
    }
  }, [settings.notepad]);

  const onChange = (v: string): void => {
    setDraft(v);
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      lastSavedRef.current = v;
      void update({ notepad: v });
    }, SAVE_DEBOUNCE_MS);
  };

  // unmount で確定保存
  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        if (draft !== lastSavedRef.current) {
          void update({ notepad: draft });
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(draft);
      toast.showToast(t('notes.copied'), { tone: 'success' });
    } catch {
      toast.showToast(t('notes.copyFailed'), { tone: 'error' });
    }
  };

  const onClear = (): void => {
    if (draft.length === 0) return;
    if (!window.confirm(t('notes.confirmClear'))) return;
    onChange('');
  };

  return (
    <div className="notes-panel">
      <div className="notes-panel__header">
        <span className="notes-panel__title">{t('notes.title')}</span>
        <span className="notes-panel__actions">
          <button
            type="button"
            className="notes-panel__btn"
            onClick={onCopy}
            disabled={draft.length === 0}
            title={t('notes.copy')}
            aria-label={t('notes.copy')}
          >
            <Copy size={12} strokeWidth={1.85} />
          </button>
          <button
            type="button"
            className="notes-panel__btn"
            onClick={onClear}
            disabled={draft.length === 0}
            title={t('notes.clear')}
            aria-label={t('notes.clear')}
          >
            <Eraser size={12} strokeWidth={1.85} />
          </button>
        </span>
      </div>
      <textarea
        className="notes-panel__textarea"
        placeholder={t('notes.placeholder')}
        value={draft}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
      <div className="notes-panel__footer">
        {draft.length > 0 ? `${draft.length} ${t('notes.chars')}` : t('notes.autoSaved')}
      </div>
    </div>
  );
}

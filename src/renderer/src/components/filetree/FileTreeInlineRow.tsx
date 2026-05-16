import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent
} from 'react';
import {
  ChevronRight,
  FilePlus,
  FolderPlus
} from 'lucide-react';
import { fileTreeGuideStyle } from './utils';

/**
 * Issue #592: ファイルツリーのインライン入力行 (新規ファイル / 新規フォルダ / リネーム)。
 * Enter で確定 / Esc でキャンセル。blur でも確定する (VS Code と同じ挙動)。
 *
 * **PR #695 review (Correctness)**: `onSubmit` は確定が成功したかを `Promise<boolean>` で返す。
 * 失敗 (`false`) の場合は `submittingRef` を巻き戻し、再度 Enter / Esc / blur を受け付けるよう
 * フォールバックする。これがないと、初回 submit 失敗で UI が固まる。
 */
interface FileTreeInlineRowProps {
  depth: number;
  kind: 'file' | 'folder';
  placeholder: string;
  initialValue: string;
  /** 確定処理。`true` = 確定成功 (この行は閉じてよい) / `false` = 失敗で行を残す。 */
  onSubmit: (value: string) => Promise<boolean>;
  onCancel: () => void;
}

export function FileTreeInlineRow({
  depth,
  kind,
  placeholder,
  initialValue,
  onSubmit,
  onCancel
}: FileTreeInlineRowProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  // 多重 submit を防ぐ guard。submit が in-flight な間 true、決着したら結果に応じて
  // 確定 (= 行ごと unmount) or 失敗で false に巻き戻して再 submit を許可する。
  const submittingRef = useRef(false);
  const [value, setValue] = useState(initialValue);

  // Mount 直後に input にフォーカスし、リネーム時は拡張子を除いた stem 部分を選択する。
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if (initialValue) {
      const dotIdx = initialValue.lastIndexOf('.');
      if (dotIdx > 0) {
        el.setSelectionRange(0, dotIdx);
      } else {
        el.select();
      }
    }
  }, [initialValue]);

  const submit = (): void => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    // 失敗時は guard を巻き戻して再 submit を受け付ける。成功時は親が unmount するので
    // ここでは何もしない (unmount 後の setState 抑止のため、ok=true でも巻き戻さない)。
    void Promise.resolve(onSubmit(value))
      .then((ok) => {
        if (!ok) submittingRef.current = false;
      })
      .catch(() => {
        submittingRef.current = false;
      });
  };

  const cancel = (): void => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    onCancel();
  };

  const handleKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  };

  return (
    <div className="filetree__row filetree__inline-input" style={fileTreeGuideStyle(depth)}>
      {kind === 'folder' ? (
        <>
          <ChevronRight
            size={13}
            strokeWidth={2.25}
            className="filetree__chevron"
            aria-hidden
          />
          <FolderPlus
            size={14}
            strokeWidth={2}
            className="filetree__icon"
            aria-hidden
          />
        </>
      ) : (
        <>
          <span className="filetree__chevron-spacer" />
          <FilePlus
            size={14}
            strokeWidth={2}
            className="filetree__file-icon"
            aria-hidden
          />
        </>
      )}
      <input
        ref={inputRef}
        type="text"
        className="filetree__inline-input-field"
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKey}
        onBlur={submit}
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
      />
    </div>
  );
}

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';
import { X } from 'lucide-react';

/**
 * グローバルなトースト通知（Undoアクション付き）基盤。
 * 使用例:
 *   const { showToast } = useToast();
 *   showToast('スキル "xxx" を削除しました', {
 *     action: { label: 'Undo', onClick: () => restore() },
 *     duration: 5000
 *   });
 */

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  /** 自動消滅までのms（既定: 4000） */
  duration?: number;
  /** Undoアクション等 */
  action?: ToastAction;
  /** 種別: 情報/成功/警告/エラー（色分け） */
  tone?: 'info' | 'success' | 'warning' | 'error';
}

export interface Toast {
  id: number;
  message: string;
  options: ToastOptions;
  // true にセットしてから _EXIT_MS 後に配列から除去することで slide-out を見せる
  exiting?: boolean;
  // timer はクリア用に保持
  _timer?: ReturnType<typeof setTimeout>;
}

const _EXIT_MS = 220;

interface ToastContextValue {
  showToast: (message: string, options?: ToastOptions) => number;
  dismissToast: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);
const TOAST_LABELS = {
  info: '情報',
  success: '完了',
  warning: '注意',
  error: 'エラー'
} as const;

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  // exit アニメ付きで配列から除去する
  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => {
      const target = prev.find((x) => x.id === id);
      if (!target || target.exiting) return prev;
      if (target._timer) clearTimeout(target._timer);
      return prev.map((x) => (x.id === id ? { ...x, exiting: true } : x));
    });
    setTimeout(() => {
      setToasts((prev) => prev.filter((x) => x.id !== id));
    }, _EXIT_MS);
  }, []);

  const showToast = useCallback(
    (message: string, options: ToastOptions = {}): number => {
      const id = nextId.current++;
      const duration = options.duration ?? 4000;
      // 自動消滅時も exit アニメを通す
      const timer = setTimeout(() => {
        setToasts((prev) =>
          prev.map((x) => (x.id === id ? { ...x, exiting: true } : x))
        );
        setTimeout(() => {
          setToasts((prev) => prev.filter((x) => x.id !== id));
        }, _EXIT_MS);
      }, duration);
      setToasts((prev) => [
        ...prev,
        { id, message, options, _timer: timer }
      ]);
      return id;
    },
    []
  );

  const value = useMemo<ToastContextValue>(
    () => ({ showToast, dismissToast }),
    [showToast, dismissToast]
  );

  // アンマウント時のタイマー掃除
  useEffect(() => {
    return () => {
      toasts.forEach((t) => t._timer && clearTimeout(t._timer));
    };
    // 意図的に依存配列空: マウント/アンマウント時のみ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast は ToastProvider の子孫で呼び出してください');
  return ctx;
}

// ---------- 表示コンポーネント ----------

interface ToastContainerProps {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}

function ToastContainer({ toasts, onDismiss }: ToastContainerProps): JSX.Element {
  return (
    <div className="toast-container" role="status" aria-live="polite">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => onDismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastItem({
  toast,
  onDismiss
}: {
  toast: Toast;
  onDismiss: () => void;
}): JSX.Element {
  const tone = toast.options.tone ?? 'info';
  return (
    <div
      className={`toast toast--${tone}`}
      data-state={toast.exiting ? 'exiting' : 'open'}
    >
      <span className="toast__indicator" aria-hidden="true" />
      <div className="toast__body">
        <span className="toast__label">{TOAST_LABELS[tone]}</span>
        <span className="toast__message">{toast.message}</span>
      </div>
      {toast.options.action && (
        <button
          type="button"
          className="toast__action"
          onClick={() => {
            toast.options.action?.onClick();
            onDismiss();
          }}
        >
          {toast.options.action.label}
        </button>
      )}
      <button
        type="button"
        className="toast__close"
        onClick={onDismiss}
        aria-label="閉じる"
      >
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  );
}

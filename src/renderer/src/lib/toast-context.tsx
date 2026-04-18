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
import { useT } from './i18n';

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

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  // Issue #80: 既存の _timer は toast 本体の setTimeout しか覚えておらず、
  // dismissToast() の exit 側 (_EXIT_MS 後) の setTimeout はここに積まれていた。
  // provider がアンマウントされたとき、exit 側のタイマーが孤立するので集約する。
  const exitTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  // exit アニメ付きで配列から除去する
  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => {
      const target = prev.find((x) => x.id === id);
      if (!target || target.exiting) return prev;
      if (target._timer) clearTimeout(target._timer);
      return prev.map((x) => (x.id === id ? { ...x, exiting: true } : x));
    });
    const t = setTimeout(() => {
      exitTimersRef.current.delete(t);
      setToasts((prev) => prev.filter((x) => x.id !== id));
    }, _EXIT_MS);
    exitTimersRef.current.add(t);
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
        const t = setTimeout(() => {
          exitTimersRef.current.delete(t);
          setToasts((prev) => prev.filter((x) => x.id !== id));
        }, _EXIT_MS);
        exitTimersRef.current.add(t);
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

  // Issue #80: アンマウント時にタイマーを漏れなく掃除する。
  // toasts state に乗っている _timer と、dismiss 側の exit 用 setTimeout の双方。
  const toastsRef = useRef(toasts);
  toastsRef.current = toasts;
  useEffect(() => {
    return () => {
      toastsRef.current.forEach((t) => t._timer && clearTimeout(t._timer));
      exitTimersRef.current.forEach((t) => clearTimeout(t));
      exitTimersRef.current.clear();
    };
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
  const t = useT();
  const label = t(`toast.tone.${tone}`);
  return (
    <div
      className={`toast toast--${tone}`}
      data-state={toast.exiting ? 'exiting' : 'open'}
    >
      <span className="toast__indicator" aria-hidden="true" />
      <div className="toast__body">
        <span className="toast__label">{label}</span>
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
        aria-label={t('common.close')}
      >
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  );
}

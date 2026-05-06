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
import { registerToastBridge } from './toast-bridge';

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
  // Issue #80: アクティブな全 timer を Set で追跡。unmount 時に確実に clear する。
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  // 登録 → 発火時 / cleanup 時に Set から外す
  const registerTimer = useCallback((fn: () => void, ms: number) => {
    const handle: ReturnType<typeof setTimeout> = setTimeout(() => {
      timersRef.current.delete(handle);
      fn();
    }, ms);
    timersRef.current.add(handle);
    return handle;
  }, []);

  // exit アニメ付きで配列から除去する
  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => {
      const target = prev.find((x) => x.id === id);
      if (!target || target.exiting) return prev;
      if (target._timer) {
        clearTimeout(target._timer);
        timersRef.current.delete(target._timer);
      }
      return prev.map((x) => (x.id === id ? { ...x, exiting: true } : x));
    });
    registerTimer(() => {
      setToasts((prev) => prev.filter((x) => x.id !== id));
    }, _EXIT_MS);
  }, [registerTimer]);

  const showToast = useCallback(
    (message: string, options: ToastOptions = {}): number => {
      const id = nextId.current++;
      const duration = options.duration ?? 4000;
      // 自動消滅時も exit アニメを通す
      const timer = registerTimer(() => {
        setToasts((prev) =>
          prev.map((x) => (x.id === id ? { ...x, exiting: true } : x))
        );
        registerTimer(() => {
          setToasts((prev) => prev.filter((x) => x.id !== id));
        }, _EXIT_MS);
      }, duration);
      setToasts((prev) => [
        ...prev,
        { id, message, options, _timer: timer }
      ]);
      return id;
    },
    [registerTimer]
  );

  const value = useMemo<ToastContextValue>(
    () => ({ showToast, dismissToast }),
    [showToast, dismissToast]
  );

  // Issue #80: アンマウント時に進行中の全 timer を確実に clear
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const h of timers) {
        clearTimeout(h);
      }
      timers.clear();
    };
  }, []);

  // Issue #490: `SettingsProvider` (= `ToastProvider` の親) からも Toast を出せるように
  // 自分の showToast を bridge に register する。Provider 外コードは `bridgedToast()`
  // 経由で同じ表示パスに乗る。
  useEffect(() => registerToastBridge(showToast), [showToast]);

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
  // Issue #80: toast の tone label を i18n 経由で引く
  const t = useT();
  const tone = toast.options.tone ?? 'info';
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

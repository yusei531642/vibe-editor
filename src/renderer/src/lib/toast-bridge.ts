import type { ToastOptions } from './toast-context';

/**
 * Toast を React Context の外側 (= `ToastProvider` の親側) から使うための bridge。
 *
 * `SettingsProvider` は `ToastProvider` の **親** なので `useToast` を直接呼べない。
 * 一方、`SettingsProvider` の保存失敗 / setProjectRoot 失敗は **ユーザーに見える形で
 * 知らせる** べきだが、`console.error` だと開発者しか気付けない。
 *
 * このモジュールは「ToastProvider がマウント時に自分の `showToast` を register、
 * SettingsProvider 側はその参照経由で通知する」という最小の wiring を提供する。
 * register 前 (= ToastProvider が未マウント / unmount 後) の呼び出しは silently no-op。
 *
 * 実装は単一のクロージャ参照のみ。グローバル listener や event 系の重い設備は不要。
 */

type ShowToastFn = (message: string, options?: ToastOptions) => unknown;

let registeredShowToast: ShowToastFn | null = null;

/** `ToastProvider` が自分の `showToast` を bridge に register する。
 *  unmount 時は同じ参照を `null` に戻して dangling 呼び出しを防ぐ。
 *  StrictMode の double-mount 等で複数登録された場合は **最後勝ち** で上書きする
 *  (古い provider は既に unmount 直前か、新しい方が現役なため)。 */
export function registerToastBridge(fn: ShowToastFn): () => void {
  registeredShowToast = fn;
  return () => {
    if (registeredShowToast === fn) {
      registeredShowToast = null;
    }
  };
}

/** Provider 外のコード (e.g. `SettingsProvider` の保存失敗ハンドラ) から呼び出す。
 *  Toast が利用可能なら表示、未登録なら `console.error` にフォールバックする。 */
export function bridgedToast(message: string, options?: ToastOptions): void {
  if (registeredShowToast) {
    registeredShowToast(message, options);
    return;
  }
  // Provider 外で Toast がまだ立ち上がっていないタイミング (アプリ起動直後 等) は
  // せめてコンソールに残しておく。Toast に出せた時点では console には流さず、
  // ユーザーへの通知に一本化する。
  // eslint-disable-next-line no-console
  console.error('[toast-bridge]', message);
}

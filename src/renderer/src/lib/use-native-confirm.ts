/**
 * useNativeConfirm — `window.confirm` の代替となる Tauri ネイティブ確認ダイアログ hook。
 *
 * 背景 (Issue #733):
 *   WebView の `window.confirm` はネイティブ感が無く a11y もブラウザ依存。App.tsx /
 *   AppShell.tsx は既に `@tauri-apps/plugin-dialog` の `ask` に統一済み。本 hook で
 *   残りの確認ダイアログも同じネイティブ dialog に揃える。
 *
 * 使い方:
 *   const confirm = useNativeConfirm();
 *   if (await confirm(t('foo.confirmDelete'))) { ... }
 *
 *   返り値は `(message, options?) => Promise<boolean>`。OK で `true` / Cancel で
 *   `false` を resolve するため、`window.confirm` の「OK で実行 / Cancel で中止」
 *   ロジックをそのまま `await` 付きで置き換えられる。
 */
import { useCallback } from 'react';

export interface NativeConfirmOptions {
  /** ダイアログのタイトル。既定は 'vibe-editor'。 */
  title?: string;
  /** ダイアログの種別。既定は確認系として 'warning'。 */
  kind?: 'info' | 'warning' | 'error';
  /** OK ボタンのラベル。 */
  okLabel?: string;
  /** Cancel ボタンのラベル。 */
  cancelLabel?: string;
}

/** ネイティブ確認ダイアログを開く関数。OK で `true` / Cancel で `false`。 */
export type NativeConfirm = (
  message: string,
  options?: NativeConfirmOptions
) => Promise<boolean>;

/**
 * Tauri ネイティブ確認ダイアログを返す hook。
 * `ask` は動的 import する (AppShell / updater-check の既存パターンに合わせる)。
 */
export function useNativeConfirm(): NativeConfirm {
  return useCallback<NativeConfirm>(async (message, options) => {
    const { ask } = await import('@tauri-apps/plugin-dialog');
    return ask(message, {
      title: options?.title ?? 'vibe-editor',
      kind: options?.kind ?? 'warning',
      okLabel: options?.okLabel,
      cancelLabel: options?.cancelLabel
    });
  }, []);
}

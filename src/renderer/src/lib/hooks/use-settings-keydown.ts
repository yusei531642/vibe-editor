import { useCallback } from 'react';
import type { KeyboardEvent, RefObject } from 'react';

interface UseSettingsKeydownOptions {
  dialogRef: RefObject<HTMLDivElement>;
  onClose: () => void;
}

/** Issue #195: Settings dialog の Escape + Tab focus trap ハンドラ。
 *  IME 変換中の Escape は確定キャンセルとして使われるので絶対に握らない。
 *  入力中の 1 回目 Escape は input から blur して dialog root に focus 退避、
 *  2 回目で onClose に進む UX (vscode / macOS native と同じ)。
 */
export function useSettingsKeydown(
  opts: UseSettingsKeydownOptions
): (e: KeyboardEvent<HTMLDivElement>) => void {
  const { dialogRef, onClose } = opts;
  return useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      // Issue #195: Escape で閉じる + Tab で focus trap。
      if (e.key === 'Escape') {
        // IME 変換中の Escape は確定キャンセルとして使われるので絶対に握らない。
        // React 17+ では e.nativeEvent は KeyboardEvent 型に推論されるためキャスト不要。
        if (e.nativeEvent.isComposing) return;
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName;
        // contenteditable は inherit で親から継承されるケースがあるため、
        // 文字列比較の getAttribute ではなく DOM プロパティ isContentEditable を使う
        // (継承込みの正しい判定が出る)。レビュー指摘。
        const isTextField =
          tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable === true;
        e.preventDefault();
        // 入力中の Escape で即閉じると入力中のテキストが lost するため、
        // 1 回目は input から blur して dialog root に focus を退避するだけにする。
        // (2 回目の Escape は target=dialog なのでこの分岐に入らず onClose に進む)
        if (isTextField && target) {
          target.blur();
          dialogRef.current?.focus();
          return;
        }
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = dialogRef.current;
      if (!root) return;
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(
          // セレクタ側は典型的な -1 だけを除外し、それ以外の負値や空文字 ([tabindex=""] 等) は
          // 後段 filter の el.tabIndex < 0 に委ねる (CSS attribute selector の前方一致は
          // ブラウザ間で挙動差があり、正規実装に統一するほうが堅牢)。
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => {
        // 1. tabIndex の負値 (-2 等) と dialog root (tabIndex=-1) を除外
        if (el.tabIndex < 0) return false;
        // 2. レイアウト上見えていない要素を除外。
        //    旧 getBoundingClientRect だけだと visibility:hidden の要素が rect=占有領域を
        //    持つため通過してしまう (レビュー指摘)。
        //    Chromium が提供する Element.checkVisibility() は display:none / visibility:hidden /
        //    content-visibility:hidden を 1 回呼ぶだけで判定できる。Tauri は WebView2 (Chromium)
        //    なので利用可能。型未定義環境用に typeof チェックで guard し、未対応時は
        //    旧来の rect ベース判定にフォールバック。
        const checkVisibility = (el as unknown as {
          checkVisibility?: (opts?: { checkVisibilityCSS?: boolean }) => boolean;
        }).checkVisibility;
        if (typeof checkVisibility === 'function') {
          return checkVisibility.call(el, { checkVisibilityCSS: true });
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 || rect.height > 0;
      });
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [dialogRef, onClose]
  );
}

/**
 * Issue #307 / #306: Windows のフレームレスウィンドウ (decorations: false) 最大化時に
 * OS が約 8px の不可視リサイズ境界を画面外へ拡張する挙動の補正。
 *
 * `<html>` の data-* 属性として状態を出力し、CSS 側で `--wf-*` 変数を切替える。
 *
 * 初期 render フラッシュ防止のため、useEffect 同期パートで `data-platform` を即セットし、
 * `data-window-maximized` は async 解決後に setattr。CSS 側はデフォルト値 0 にしてあるので
 * 最大化中に起動した場合のみ短時間（~1 frame）の不正描画があるが、Tauri は最大化状態を
 * 保持して dev/prod 起動するため実害は最小。
 */
import { useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

const isWindows = /Windows/i.test(navigator.userAgent);

export function useWindowFrameInsets(): void {
  useEffect(() => {
    if (!isWindows) return;
    const root = document.documentElement;
    root.dataset.platform = 'windows';
    // 初期値を即時セットして flash を最小化
    root.dataset.windowMaximized = 'false';
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void (async () => {
      try {
        const sync = async (): Promise<void> => {
          if (disposed) return;
          const maximized = await win.isMaximized();
          root.dataset.windowMaximized = String(maximized);
        };
        await sync();
        // Tauri 2: onResized は最大化/復元/手動 resize / DPI 変化全てで発火する
        unlisten = await win.onResized(sync);
      } catch (err) {
        // dev mode で window API が未解決等の場合は静かに諦める
        console.warn('[use-window-frame-insets] init failed:', err);
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}

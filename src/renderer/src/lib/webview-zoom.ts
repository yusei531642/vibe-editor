/**
 * webview 全体の zoom を一元管理する。
 *
 * Rust 側 `app_set_zoom_level` は引数を factor (0.3-3.0, 1.0=100%) として
 * `WebviewWindow::set_zoom` に渡す — Electron の webFrame.setZoomFactor 相当。
 * WebView2 / wry は get API を提供しないため、last-set 値をフロントで保持する。
 *
 * Ctrl+=/-/0 (main.tsx) と Shift+wheel (App.tsx) の両経路がここを経由することで、
 * どちらから操作しても状態が食い違わない。
 */

const MIN = 0.5;
const MAX = 3.0;
const STEP = 0.1;

let current = 1.0;
// Issue #161: settings 永続化への書き戻し callback。SettingsProvider 起動時に登録される。
let persistCallback: ((next: number) => void) | null = null;

const clamp = (v: number): number => Math.max(MIN, Math.min(MAX, v));

const apply = (next: number): void => {
  current = clamp(next);
  void window.api.app.setZoomLevel(current).catch((err) => {
    console.warn('[zoom] setZoomLevel failed:', err);
  });
  if (persistCallback) {
    try {
      persistCallback(current);
    } catch (err) {
      console.warn('[zoom] persist callback failed:', err);
    }
  }
};

export const webviewZoom = {
  STEP,
  get: (): number => current,
  in: (): void => apply(current + STEP),
  out: (): void => apply(current - STEP),
  reset: (): void => apply(1.0),
  adjust: (delta: number): void => apply(current + delta),
  /**
   * 起動時に settings 復元値で内部 current を揃え、apply で WebView2 にも反映する。
   * これにより `apply` 経由で初期 zoom と内部 current が必ず一致する。
   */
  restoreFromSettings: (savedZoom: number | undefined): void => {
    const v = clamp(typeof savedZoom === 'number' && savedZoom > 0 ? savedZoom : 1.0);
    current = v;
    void window.api.app.setZoomLevel(v).catch((err) => {
      console.warn('[zoom] restore setZoomLevel failed:', err);
    });
  },
  /** 永続化 callback を登録 (apply のたびに呼ばれる)。 */
  setPersistCallback: (cb: ((next: number) => void) | null): void => {
    persistCallback = cb;
  }
};

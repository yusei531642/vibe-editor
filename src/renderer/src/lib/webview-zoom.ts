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

const clamp = (v: number): number => Math.max(MIN, Math.min(MAX, v));

const apply = (next: number): void => {
  current = clamp(next);
  void window.api.app.setZoomLevel(current).catch((err) => {
    console.warn('[zoom] setZoomLevel failed:', err);
  });
};

export const webviewZoom = {
  STEP,
  get: (): number => current,
  in: (): void => apply(current + STEP),
  out: (): void => apply(current - STEP),
  reset: (): void => apply(1.0),
  adjust: (delta: number): void => apply(current + delta)
};

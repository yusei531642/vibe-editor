/**
 * useCanvasVisibility — Canvas (= Tauri webview) の可視状態を統合的に観測する hook。
 *
 * 「可視」とは:
 *   - `document.visibilityState === 'visible'` (タブ / window がブラウザ的に visible)
 *   - **かつ** Tauri Window がフォーカスされている (= ユーザの一次注意がここにある)
 *
 * 両方満たしたときに `isCanvasVisible = true`、片方でも欠けたら `false`。
 *
 * Issue #578: Canvas 非表示中に `team:recruit-request` が走ると、ユーザは採用結果を
 * 視認できないまま終わるため、可視化遷移時にまとめて通知する基盤として使う。
 *
 * 設計:
 *   - 状態と subscriber 集合は **モジュールレベル singleton**。複数 hook 呼び出しでも
 *     `document` / `window` / Tauri `onFocusChanged` のリスナーは 1 セットだけ。
 *   - hook は `useState` を介して reactive な `isCanvasVisible` を返すので、UI 更新にも使える。
 *   - hidden 経過時間を取得する `getHiddenSinceMs()` を別関数で公開 (recruit IPC のしきい値判定用)。
 *   - `subscribeOnVisible(cb)` は **hidden → visible 遷移時のみ** cb を発火させる。
 *     既に visible のときに subscribe しても発火しない (= edge trigger)。
 *
 * テスト:
 *   - vitest 環境では Tauri runtime が無いので `getCurrentWindow()` の動的 import が
 *     reject されることがある。それは silently 無視し、`document.visibilitychange` /
 *     `window.focus`|`blur` だけで動かす。
 *   - `__resetCanvasVisibilityForTests()` で singleton state を初期化できる。
 */
import { useEffect, useState } from 'react';

interface CanvasVisibilityState {
  /** document.visibilityState !== 'hidden' */
  documentVisible: boolean;
  /** Tauri Window / browser window がフォーカスを持っている */
  windowFocused: boolean;
  /** hidden に転じた瞬間の Date.now()。visible なら null */
  hiddenSinceMs: number | null;
}

const state: CanvasVisibilityState = {
  documentVisible: true,
  windowFocused: true,
  hiddenSinceMs: null
};

const subscribers = new Set<() => void>();

let initialized = false;
let unlistenDoc: (() => void) | null = null;
let unlistenFocus: (() => void) | null = null;
let unlistenBlur: (() => void) | null = null;
let unlistenTauriFocus: (() => void) | null = null;

function isVisibleNowInternal(): boolean {
  return state.documentVisible && state.windowFocused;
}

function notify(): void {
  // copy to avoid mutation while iterating
  for (const cb of [...subscribers]) {
    try {
      cb();
    } catch (err) {
      console.error('[canvas-visibility] subscriber threw', err);
    }
  }
}

function applyTransition(): void {
  const visibleNow = isVisibleNowInternal();
  const wasHidden = state.hiddenSinceMs !== null;
  if (visibleNow && wasHidden) {
    // hidden → visible
    state.hiddenSinceMs = null;
    notify();
  } else if (!visibleNow && !wasHidden) {
    // visible → hidden
    state.hiddenSinceMs = Date.now();
    notify();
  }
}

function ensureInit(): void {
  if (initialized) return;
  initialized = true;

  if (typeof document !== 'undefined') {
    state.documentVisible = document.visibilityState !== 'hidden';
  }
  if (typeof document !== 'undefined' && typeof document.hasFocus === 'function') {
    state.windowFocused = document.hasFocus();
  }
  state.hiddenSinceMs = isVisibleNowInternal() ? null : Date.now();

  if (typeof document !== 'undefined') {
    const onVisibilityChange = (): void => {
      state.documentVisible = document.visibilityState !== 'hidden';
      applyTransition();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    unlistenDoc = () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }

  if (typeof window !== 'undefined') {
    const onFocus = (): void => {
      state.windowFocused = true;
      applyTransition();
    };
    const onBlur = (): void => {
      state.windowFocused = false;
      applyTransition();
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    unlistenFocus = () => window.removeEventListener('focus', onFocus);
    unlistenBlur = () => window.removeEventListener('blur', onBlur);
  }

  // Tauri Window の onFocusChanged を best-effort で購読する。
  // 通常は window.focus/blur で十分だが、フレームレス + カスタム title bar 環境では
  // OS 側 focus 変化が webview event に乗らない場合があるため重ね掛けする。
  void (async () => {
    try {
      const mod = await import('@tauri-apps/api/window');
      const win = mod.getCurrentWindow();
      const off = await win.onFocusChanged((event) => {
        state.windowFocused = event.payload;
        applyTransition();
      });
      unlistenTauriFocus = off;
    } catch {
      // Tauri runtime が無い (vitest / pure browser) — silently 諦める。
    }
  })();
}

/**
 * 現在 Canvas が可視か。hidden→visible 遷移時の callback を escape したいときに同期で参照する。
 * recruit listener など hook 外でも呼べるように export している。
 */
export function isCanvasVisibleNow(): boolean {
  ensureInit();
  return isVisibleNowInternal();
}

/**
 * hidden 状態が始まった時点の `Date.now()`。visible なら `null`。
 * IPC `recruit_observed_while_hidden` のしきい値判定 (5000ms) で使う。
 */
export function getHiddenSinceMs(): number | null {
  ensureInit();
  return state.hiddenSinceMs;
}

/**
 * **hidden → visible 遷移時のみ** cb を発火する subscriber を登録する。
 * 戻り値の関数で解除。subscribe 時点で visible でも cb は発火しない (edge trigger)。
 */
export function subscribeOnVisible(cb: () => void): () => void {
  ensureInit();
  const wrapped = (): void => {
    if (isVisibleNowInternal()) cb();
  };
  subscribers.add(wrapped);
  return () => {
    subscribers.delete(wrapped);
  };
}

export interface CanvasVisibilityHook {
  /** 現在 Canvas が可視か (reactive)。 */
  isCanvasVisible: boolean;
  /** hidden→visible 遷移時のみ呼ばれる subscriber を登録する。 */
  subscribeOnVisible(cb: () => void): () => void;
}

/**
 * React 側で `isCanvasVisible` を reactive に参照したいときに使う hook。
 * 内部の listener セットは singleton なので複数箇所で呼んでも multiplicative にはならない。
 */
export function useCanvasVisibility(): CanvasVisibilityHook {
  ensureInit();
  const [isCanvasVisible, setIsCanvasVisible] = useState<boolean>(() =>
    isVisibleNowInternal()
  );
  useEffect(() => {
    const update = (): void => setIsCanvasVisible(isVisibleNowInternal());
    subscribers.add(update);
    // mount 直後に singleton state とズレている可能性に備えて 1 度同期する
    update();
    return () => {
      subscribers.delete(update);
    };
  }, []);
  return {
    isCanvasVisible,
    subscribeOnVisible
  };
}

/**
 * vitest 用: singleton 状態を初期化してリスナーも全部外す。
 * test ファイル間で漏れた DOM listener が後続テストを壊さないようにする。
 */
export function __resetCanvasVisibilityForTests(): void {
  unlistenDoc?.();
  unlistenFocus?.();
  unlistenBlur?.();
  unlistenTauriFocus?.();
  unlistenDoc = null;
  unlistenFocus = null;
  unlistenBlur = null;
  unlistenTauriFocus = null;
  initialized = false;
  subscribers.clear();
  state.documentVisible = true;
  state.windowFocused = true;
  state.hiddenSinceMs = null;
}

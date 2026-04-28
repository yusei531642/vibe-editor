import { useEffect, useRef } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { computeUnscaledGrid } from './compute-unscaled-grid';
import type { CellSize } from './measure-cell-size';

const VISIBLE_FIT_DELAY_MS = 30;
const ZOOM_DEBOUNCE_MS = 100;

/**
 * Issue #253 解消の核フック。
 *
 * IDE モード (transform 非適用): 従来どおり `FitAddon.fit()` で getBoundingClientRect 経由の
 *   実 px サイズから cols/rows を決める。
 *
 * Canvas モード (`transform: scale(zoom)` 配下、`unscaledFit=true`):
 *   `getBoundingClientRect()` は transform 適用後の視覚矩形を返してしまうため、
 *   `container.clientWidth / clientHeight` (論理 px、transform 非影響) と
 *   `getCellSize()` のセルメトリクス (zoom 非依存) から `computeUnscaledGrid` で
 *   cols/rows を直接算出 → `term.resize()` を呼ぶ。これにより zoom が変わっても PTY に
 *   一定の cols/rows が渡り、Codex/Claude TUI が崩れない。
 *
 * `unscaledFit=false` のままなら IDE モードと同じ挙動 (regression ゼロ)。
 */
export interface UseFitToContainerOptions {
  containerRef: RefObject<HTMLDivElement>;
  termRef: MutableRefObject<Terminal | null>;
  fitRef: MutableRefObject<FitAddon | null>;
  ptyIdRef: MutableRefObject<string | null>;
  visible: boolean;
  /** theme / font 変更時に refit したい場合はここに値を並べる */
  refitTriggers: unknown[];
  /** Canvas モードで論理 px ベース fit を有効化する */
  unscaledFit?: boolean;
  /** unscaled fit で使うセルメトリクスを取得。フォント変更を毎回拾うので関数で渡す */
  getCellSize?: () => CellSize | null;
  /** Canvas zoom の購読関数。返値は unsubscribe。zoom 変化で refit を発火 */
  zoomSubscribe?: (cb: () => void) => () => void;
}

export function useFitToContainer(options: UseFitToContainerOptions): void {
  const {
    containerRef,
    termRef,
    fitRef,
    ptyIdRef,
    visible,
    refitTriggers,
    unscaledFit = false,
    getCellSize,
    zoomSubscribe
  } = options;

  // visible / unscaledFit / getCellSize の最新値を ref で見る (RO 再マウント不要)
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const unscaledFitRef = useRef(unscaledFit);
  unscaledFitRef.current = unscaledFit;
  const getCellSizeRef = useRef(getCellSize);
  getCellSizeRef.current = getCellSize;

  // PTY resize IPC を debounce (リサイズ中の毎フレーム IPC 抑制)
  const ptyResizeTimerRef = useRef<number | null>(null);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const lastScheduledRef = useRef<{ cols: number; rows: number } | null>(null);

  const schedulePtyResize = (cols: number, rows: number): void => {
    if (
      lastScheduledRef.current &&
      lastScheduledRef.current.cols === cols &&
      lastScheduledRef.current.rows === rows
    ) {
      return;
    }
    lastScheduledRef.current = { cols, rows };
    if (ptyResizeTimerRef.current !== null) {
      window.clearTimeout(ptyResizeTimerRef.current);
    }
    ptyResizeTimerRef.current = window.setTimeout(() => {
      ptyResizeTimerRef.current = null;
      const id = ptyIdRef.current;
      if (!id) return;
      lastSizeRef.current = { cols, rows };
      void window.api.terminal.resize(id, cols, rows);
    }, 120);
  };

  const refit = (): void => {
    const term = termRef.current;
    if (!term) return;
    const container = containerRef.current;

    if (unscaledFitRef.current && container) {
      const getCell = getCellSizeRef.current;
      const cell = getCell?.();
      if (!cell) return;
      const grid = computeUnscaledGrid(
        container.clientWidth,
        container.clientHeight,
        cell.cellW,
        cell.cellH
      );
      if (!grid) return;
      try {
        term.resize(grid.cols, grid.rows);
        term.refresh(0, Math.max(0, term.rows - 1));
        if (ptyIdRef.current) {
          schedulePtyResize(grid.cols, grid.rows);
        }
      } catch {
        /* dispose 直後 / 非可視などの失敗は無視 */
      }
      return;
    }

    // 従来 IDE モード経路
    const fit = fitRef.current;
    if (!fit) return;
    try {
      fit.fit();
      term.refresh(0, Math.max(0, term.rows - 1));
      if (ptyIdRef.current) {
        schedulePtyResize(term.cols, term.rows);
      }
    } catch {
      /* 非表示状態などでの失敗は無視 */
    }
  };

  // ResizeObserver は一度だけ作る
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let resizePending = false;
    const ro = new ResizeObserver(() => {
      if (!visibleRef.current) return;
      if (resizePending) return;
      resizePending = true;
      requestAnimationFrame(() => {
        resizePending = false;
        refit();
      });
    });
    ro.observe(container);
    return () => {
      ro.disconnect();
      if (ptyResizeTimerRef.current !== null) {
        window.clearTimeout(ptyResizeTimerRef.current);
        ptyResizeTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 不変式 #5: 可視状態に切り替わったら 30ms 後に再 fit + focus
  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => {
      refit();
      termRef.current?.focus();
    }, VISIBLE_FIT_DELAY_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // テーマ / フォント変化時にも refit する
  useEffect(() => {
    refit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, refitTriggers);

  // Canvas zoom 変化を購読して refit を debounce 発火させる
  useEffect(() => {
    if (!unscaledFit || !zoomSubscribe) return;
    let timer: number | null = null;
    const unsubscribe = zoomSubscribe(() => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        if (!visibleRef.current) return;
        refit();
      }, ZOOM_DEBOUNCE_MS);
    });
    return () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unscaledFit, zoomSubscribe]);
}

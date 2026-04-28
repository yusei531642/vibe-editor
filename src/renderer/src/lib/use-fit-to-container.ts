import { useCallback, useEffect, useRef } from 'react';
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
  /** 可観測性ログ用に現在の zoom を取得 (`console.debug('pty.resize', ...)` に乗る) */
  getZoom?: () => number;
  /**
   * 「最後にスケジュールした PTY サイズ」を usePtySession と共有する ref。
   * spawn 時の `term.resize(cols, rows)` 後に seed しておくと、初回 30ms 後 refit の
   * `schedulePtyResize` が dedupe で IPC を skip して二重 SIGWINCH を抑止できる。
   * 渡されない場合は内部で生成 (IDE モード等で実害なし)。
   */
  lastScheduledRef?: MutableRefObject<{ cols: number; rows: number } | null>;
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
    zoomSubscribe,
    getZoom,
    lastScheduledRef: externalLastScheduledRef
  } = options;

  // visible / unscaledFit / getCellSize の最新値を ref で見る (RO 再マウント不要)
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const unscaledFitRef = useRef(unscaledFit);
  unscaledFitRef.current = unscaledFit;
  const getCellSizeRef = useRef(getCellSize);
  getCellSizeRef.current = getCellSize;
  const getZoomRef = useRef(getZoom);
  getZoomRef.current = getZoom;

  // PTY resize IPC を debounce (リサイズ中の毎フレーム IPC 抑制)
  const ptyResizeTimerRef = useRef<number | null>(null);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  // usePtySession と共有可能な「最後にスケジュールしたサイズ」ref。
  // 外部から渡されたらそれを使い、初回 spawn 時の seed が dedupe を効かせる。
  const internalLastScheduledRef = useRef<{ cols: number; rows: number } | null>(null);
  const lastScheduledRef = externalLastScheduledRef ?? internalLastScheduledRef;

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

  // Issue #253 review (W#4): refit を useCallback でラップして identity を安定化させる。
  // すべての可変値は ref 経由 (unscaledFitRef / getCellSizeRef / getZoomRef / lastScheduledRef
  // など) で読むため deps は空でよく、stale closure にはならない。これにより effect が
  // 再実行されない設計が型レベルでも明示され、後続保守者が deps に直接 props を渡す
  // 変更を入れて無限ループを引き起こすリスクを下げる。
  const refit = useCallback((): void => {
    const term = termRef.current;
    if (!term) return;
    const container = containerRef.current;

    // Issue #253 review (#4): unscaled モード優先のガード。
    // Canvas モードがオンなら、container 不在 / cell 未取得 / grid 算出失敗のいずれでも
    // IDE 経路の fit.fit() に**フォールバックしない**。fit.fit() は getBoundingClientRect
    // 経由で transform 後の視覚矩形を読んでしまうため、Canvas モード中に呼ぶと主因 P6 が
    // 一瞬だけ再発する。unscaled モードでは黙って return し、後続の ResizeObserver / zoom
    // 購読 / fonts.ready 経路で再 refit を待つ方が安全。
    if (unscaledFitRef.current) {
      if (!container) return;
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
        if (import.meta.env.DEV) {
          console.debug('pty.resize', {
            cols: grid.cols,
            rows: grid.rows,
            zoom: getZoomRef.current?.() ?? null,
            source: 'unscaled',
            cellW: cell.cellW,
            cellH: cell.cellH,
            fallback: cell.fallback
          });
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
      if (import.meta.env.DEV) {
        console.debug('pty.resize', {
          cols: term.cols,
          rows: term.rows,
          zoom: null,
          source: 'fit'
        });
      }
    } catch {
      /* 非表示状態などでの失敗は無視 */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Issue #253 sub (M2): webfont (JetBrains Mono Variable 等) のロード前に
  // measureCellSize が走ると system monospace のメトリクスを返すため、初回 spawn の
  // cellW がずれた grid で PTY が立つ。document.fonts.ready で全 webfont ロード完了を
  // 待ち、unscaled モードなら 1 回だけ refit を発火して正しい寸法に上書きする。
  useEffect(() => {
    if (!unscaledFit) return;
    if (typeof document === 'undefined' || !document.fonts) return;
    let cancelled = false;
    document.fonts.ready
      .then(() => {
        if (cancelled) return;
        refit();
      })
      .catch(() => {
        /* fonts.ready は通常 reject しないが、念のため握りつぶす */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unscaledFit]);

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

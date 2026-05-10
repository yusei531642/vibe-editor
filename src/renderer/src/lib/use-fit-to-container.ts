import { useCallback, useEffect, useRef } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { computeUnscaledGrid } from './compute-unscaled-grid';
import { getXtermRuntimeCellSize } from './get-xterm-runtime-cell-size';
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
  // Issue #665: refit() が grid (cols/rows) を実際に term へ適用した直近の値。
  //   `lastScheduledRef` (= IPC 側 dedup 用「最後にスケジュールした値」) と分離する責務:
  //     IPC 側は spawn 時に usePtySession から seed されるので、その時点で値があっても
  //     local 側は未適用扱いにして初回 refit を必ず通したい (xterm が seeded 状態と
  //     同じ cols/rows で動いているとは限らないため)。
  //   refit が実際に term.resize() / term.refresh() を呼んだ後に書き込み、次回以降の
  //   refit で grid 不変なら xterm 側の更新を skip する。container resize / font 変更で
  //   cellW/cellH が変われば grid が変わるため、見え方の正しさは保たれる。
  const lastAppliedGridRef = useRef<{ cols: number; rows: number } | null>(null);

  // Issue #253 review (#6): refit と整合させるため useCallback でラップして identity を
  // 安定化。内部で参照する lastScheduledRef / ptyResizeTimerRef / ptyIdRef / lastSizeRef は
  // 全て ref なので deps は空で stale closure なし。
  const schedulePtyResize = useCallback((cols: number, rows: number): void => {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Issue #253 review (W#4): refit を useCallback でラップして identity を安定化させる。
  // すべての可変値は ref 経由 (unscaledFitRef / getCellSizeRef / getZoomRef / lastScheduledRef
  // など) で読むため deps は空でよく、stale closure にはならない。これにより effect が
  // 再実行されない設計が型レベルでも明示され、後続保守者が deps に直接 props を渡す
  // 変更を入れて無限ループを引き起こすリスクを下げる。
  //
  // ★ 不変条件 (review #3 強化):
  //   refit と schedulePtyResize は **外部 props や毎レンダー作られる closure 値を直接参照
  //   しないこと**。可変値はすべて ref (unscaledFitRef / getCellSizeRef / getZoomRef /
  //   lastScheduledRef / ptyResizeTimerRef / lastScheduledRef / lastSizeRef / lastScheduledRef
  //   等) 経由で読む。これに違反すると refit が初回レンダーの古い値を読み続ける stale
  //   closure バグになる (useCallback の deps が空のため)。
  //   schedulePtyResize は本フック関数本体内で定義された closure だが、内部で参照する変数も
  //   すべて ref か module-level なので OK。新規変数を closure で読みたい場合は必ず ref 化
  //   してから参照すること。
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
      // Issue #272: xterm 自身が保持する実 cell サイズを優先。取れなければ Canvas 2D
      // measureText ベースの getCellSize にフォールバック。これで rows fit が xterm
      // 内部 rows と一致し、`.xterm-screen` の固定 px 高さがカード高さに揃う。
      const runtimeCell = getXtermRuntimeCellSize(term);
      const fallbackCell = getCellSizeRef.current?.() ?? null;
      const cell = runtimeCell ?? fallbackCell;
      if (!cell) return;
      const source = runtimeCell ? 'unscaled-runtime' : 'unscaled-fallback';
      const grid = computeUnscaledGrid(
        container.clientWidth,
        container.clientHeight,
        cell.cellW,
        cell.cellH
      );
      if (!grid) return;
      // Issue #665: zoom 変化のたびに refit が呼ばれるが、`container.clientWidth/Height` は
      //   transform: scale(zoom) の影響を受けない論理 px のため、ズーム単独で grid (cols/rows)
      //   は変わらない。それでも従来は無条件に `term.resize()` + `term.refresh(0, rows-1)` を
      //   毎回叩いていたため、zoom 操作中 / Claude が長文出力中の Canvas ターミナルで
      //   xterm の DOM 全行が再ラスタライズされ、フレーム落ちの主因となっていた。
      //   `xterm.resize()` は同サイズなら内部で短絡するが、明示の `refresh()` は常に走る。
      //   ここで grid 同値時は xterm 側更新を skip し、IPC 側 dedup と協調させて完全 no-op に。
      const lastApplied = lastAppliedGridRef.current;
      if (
        lastApplied &&
        lastApplied.cols === grid.cols &&
        lastApplied.rows === grid.rows
      ) {
        if (ptyIdRef.current) {
          schedulePtyResize(grid.cols, grid.rows);
        }
        if (import.meta.env.DEV) {
          console.debug('pty.resize', {
            cols: grid.cols,
            rows: grid.rows,
            zoom: getZoomRef.current?.() ?? null,
            source,
            cellW: cell.cellW,
            cellH: cell.cellH,
            fallback: runtimeCell ? false : fallbackCell?.fallback,
            skipped: 'grid-unchanged'
          });
        }
        return;
      }
      try {
        term.resize(grid.cols, grid.rows);
        term.refresh(0, Math.max(0, term.rows - 1));
        lastAppliedGridRef.current = { cols: grid.cols, rows: grid.rows };
        if (ptyIdRef.current) {
          schedulePtyResize(grid.cols, grid.rows);
        }
        if (import.meta.env.DEV) {
          console.debug('pty.resize', {
            cols: grid.cols,
            rows: grid.rows,
            zoom: getZoomRef.current?.() ?? null,
            source,
            cellW: cell.cellW,
            cellH: cell.cellH,
            fallback: runtimeCell ? false : fallbackCell?.fallback
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
      // Issue #665: IDE 経路でも grid (cols/rows) が前回と同じなら xterm 全行 refresh は
      //   不要 (フォント変更時は use-xterm-instance.ts の fonts.ready effect で別途 refresh
      //   される)。fit.fit() は内部で getBoundingClientRect を読むので、container サイズが
      //   実際に変わったときだけ cols/rows が変わる。grid 不変時に refresh を skip。
      const lastApplied = lastAppliedGridRef.current;
      const gridUnchanged =
        lastApplied !== null &&
        lastApplied.cols === term.cols &&
        lastApplied.rows === term.rows;
      if (!gridUnchanged) {
        term.refresh(0, Math.max(0, term.rows - 1));
        lastAppliedGridRef.current = { cols: term.cols, rows: term.rows };
      }
      if (ptyIdRef.current) {
        schedulePtyResize(term.cols, term.rows);
      }
      if (import.meta.env.DEV) {
        console.debug('pty.resize', {
          cols: term.cols,
          rows: term.rows,
          zoom: null,
          source: gridUnchanged ? 'fit-skip' : 'fit'
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
  // 待ち、Canvas / IDE のどちらでも 1 回だけ refit を発火して正しい寸法に上書きする。
  useEffect(() => {
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

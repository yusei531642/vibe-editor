import { useEffect, useRef } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';

const VISIBLE_FIT_DELAY_MS = 30;

/**
 * コンテナサイズ変化と可視状態切り替えに追従して `FitAddon` を呼び、
 * pty 側にも新しい cols/rows を渡す。
 *
 * 不変式 #5:
 *   - 可視状態に切り替わったタイミングで `setTimeout(..., 30)` を経由して
 *     `fit + resize + focus` を行う。これは DOM が data-state='visible' に
 *     書き換わってから 1 フレーム以上待つための猶予。
 *
 * ResizeObserver は rAF でスロットルし、フレームあたり 1 回だけ fit する。
 */
export function useFitToContainer(options: {
  containerRef: RefObject<HTMLDivElement>;
  termRef: MutableRefObject<Terminal | null>;
  fitRef: MutableRefObject<FitAddon | null>;
  ptyIdRef: MutableRefObject<string | null>;
  visible: boolean;
  /** theme / font 変更時に refit したい場合はここに値を並べる */
  refitTriggers: unknown[];
}): void {
  const { containerRef, termRef, fitRef, ptyIdRef, visible, refitTriggers } = options;

  // visible の最新値を見るための ref (RO を再マウントせずに済ませる)
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  // PTY resize IPC を debounce (リサイズ中の毎フレーム IPC 抑制)
  const ptyResizeTimerRef = useRef<number | null>(null);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);

  // 最後に「スケジュールした」サイズ。早期リターン判定はこちらで行う。
  // (lastSizeRef は「最後に適用した」サイズのため、A→B→A の往復リサイズで
  //  まだ発火していない T1 をキャンセルし損ねる原因になっていた)
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
    const fit = fitRef.current;
    if (!term || !fit) return;
    try {
      fit.fit();
      // Issue #190: 長時間稼働後に非可視→可視やレイアウト変動を跨ぐと、
      // xterm の既存行が再描画されず「入力した瞬間だけ見える」状態になることがある。
      // fit 後に全行 refresh して scrollback の再ラスタライズを強制する。
      term.refresh(0, Math.max(0, term.rows - 1));
      // PTY 側へのサイズ通知は debounce
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
    // 依存は refs のみ。effect の再マウントは不要。
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

  // テーマ / フォント変化時にも refit する (セル幅が変わるため pty リサイズも必要)
  useEffect(() => {
    refit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, refitTriggers);
}

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

  const refit = (): void => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    try {
      fit.fit();
      if (ptyIdRef.current) {
        void window.api.terminal.resize(ptyIdRef.current, term.cols, term.rows);
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
    return () => ro.disconnect();
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

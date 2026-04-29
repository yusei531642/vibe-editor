/**
 * useXtermScrollToBottomOnResize — Canvas 上の xterm 端末を、
 * 親コンテナのサイズ変化時に末尾までスクロールし直す共有 hook。
 *
 * 背景 (Issue #261 / #272):
 *   NodeResizer でカードを縮める→広げる→縮める…と操作したとき、内部
 *   `.xterm-viewport` の `scrollTop` が中途半端な値で残り、最終行が
 *   下端で見切れる現象がある。xterm.js は内部 Buffer に scrollback を
 *   持ち、自動末尾追従しているが、ResizeObserver の発火タイミングと
 *   xterm 側 fit の合流がずれると `scrollTop` だけ古い値で残ることがある。
 *
 *   PR #269 (Issue #261) で AgentNodeCard.tsx に inline で同等のロジックを
 *   実装済み。Issue #272 で TerminalCard.tsx にも同じ補正が必要となったため、
 *   Canvas terminal 用の小さな共有 hook として切り出した。
 *
 * 動作:
 *   - container 内の `.xterm-viewport` を都度 `querySelector` で引く
 *     (xterm.js が動的に生成するので、mount/remount に追従するため)。
 *   - ResizeObserver で container のサイズ変化を監視し、変化を検知したら
 *     `requestAnimationFrame` で xterm の reflow を待ってから
 *     `scrollTop = scrollHeight` を設定。
 *   - 初回 mount 時点で `.xterm-viewport` がまだ生成されていないケースに
 *     備え、100ms 遅延の補正を 1 回だけ走らせる。
 *   - cleanup で ResizeObserver / timer を解放する。
 *
 * 適用範囲:
 *   - Canvas モードの TerminalCard / AgentNodeCard でのみ使う想定。
 *   - IDE モードの TerminalView は親が `min-height: 0` の flex で完全
 *     フィットするため本 hook は適用しない (挙動が変わらないこと)。
 */
import { useEffect, type RefObject } from 'react';

/**
 * @param containerRef xterm-viewport を内包する DOM ノード (例: `.canvas-agent-card__term`)
 *                     の ref。null のときは何もせず early return する。
 * @param scrollToBottom xterm の public API (`Terminal.scrollToBottom`) を呼ぶ callback。
 *                     渡された場合は `.xterm-scrollable-element` の DOM scrollTop を直接
 *                     書き換える代わりに xterm 自前の scroll model 経由でスクロールする
 *                     (Issue #272 v3)。未指定時は fallback として `.xterm-viewport` に
 *                     `scrollTop = scrollHeight` を当てる (既存テスト互換)。
 */
export function useXtermScrollToBottomOnResize(
  containerRef: RefObject<HTMLElement | null>,
  scrollToBottom?: () => void
): void {
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    let rafId: number | null = null;
    const scrollViewportToBottom = (): void => {
      // requestAnimationFrame で xterm の reflow を待ってから scroll する。
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        if (scrollToBottom) {
          // Issue #272 v3: xterm v6 の SmoothScrollableElement は内部 scroll model で
          // scrollback を管理しているため、DOM の scrollTop を直接書いても同期しない。
          // 必ず xterm public API (Terminal.scrollToBottom) を経由する。
          scrollToBottom();
          return;
        }
        // scrollToBottom callback が無いとき (旧呼出し / 既存テスト互換) のみ
        // fallback として `.xterm-viewport` に DOM scrollTop を書く。
        const viewport = node.querySelector<HTMLElement>('.xterm-viewport');
        if (viewport) viewport.scrollTop = viewport.scrollHeight;
      });
    };

    const ro = new ResizeObserver(() => {
      scrollViewportToBottom();
    });
    ro.observe(node);

    // 初回 mount 直後は `.xterm-viewport` がまだ生成されていないケースが
    // あるため 100ms 遅延で 1 回だけ補正する。
    const initialTimer = window.setTimeout(scrollViewportToBottom, 100);

    return () => {
      ro.disconnect();
      window.clearTimeout(initialTimer);
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
    };
    // ref オブジェクト自体は安定。scrollToBottom は呼出し側で useCallback により
    // 安定化される想定なので、変更時は再 subscribe する。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToBottom]);
}

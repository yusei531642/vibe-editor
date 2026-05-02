/**
 * Issue #397: Canvas モード (React Flow `transform: scale(zoom)` 配下) で xterm の
 * 範囲選択座標がずれる問題を、capture phase で MouseEvent を論理座標へ変換した synthetic
 * イベントに差し替えることで解消する hook。
 *
 * 仕様:
 * - 適用条件: `unscaledFit === true` かつ `getZoom()` が 1 から十分離れている
 *   (|zoom - 1| >= 0.01)。IDE モード (unscaledFit !== true) では何もしない。
 * - 対象 event: 主ボタン (button === 0) の `mousedown` / `mousemove` / `mouseup` だけ。
 *   wheel / contextmenu / keyboard / paste はパススルー。
 * - 元イベント発火順: `capture phase` で握り潰し (`preventDefault` +
 *   `stopImmediatePropagation`) → 論理座標に補正した `new MouseEvent` を target に
 *   `dispatchEvent` で再投入。modifier / button / buttons / detail / view / movementX/Y は
 *   全保持。
 * - **document-level の追加 listener** (codex review #397 反映): xterm の
 *   SelectionService と CoreBrowserTerminal.bindMouse はドラッグ開始後に
 *   `document` 上で `mousemove` / `mouseup` を購読する。container だけだとドラッグが
 *   端末外に出た瞬間に native 座標が xterm に届いて再びずれる。container 用と
 *   document 用の 2 段で capture-phase listener を張り、どちらの経路でも論理座標化する。
 * - 再帰防止: synthetic に `__vibeNormalized = true` を立て、capture phase 受信側で
 *   それを見たら no-op で抜ける。
 */
import { useEffect, type RefObject } from 'react';
import { normalizeCanvasTerminalClientPoint } from './canvas-terminal-pointer';

interface NormalizedMouseEvent extends MouseEvent {
  __vibeNormalized?: boolean;
}

interface PointerNormalizerOptions {
  containerRef: RefObject<HTMLElement>;
  unscaledFit: boolean | undefined;
  getZoom: (() => number) | undefined;
}

const TRACKED_TYPES = ['mousedown', 'mousemove', 'mouseup'] as const;

export function useCanvasTerminalPointerNormalizer({
  containerRef,
  unscaledFit,
  getZoom
}: PointerNormalizerOptions): void {
  useEffect(() => {
    if (!unscaledFit || !getZoom) return;
    const container = containerRef.current;
    if (!container) return;

    /**
     * ドラッグ中フラグ。container 内で primary mousedown を握り潰した瞬間に true、
     * mouseup で false。document-level の mousemove/mouseup はこのフラグが true の
     * ときだけ補正する (xterm 外の純粋な document mousemove を不必要に書き換えない)。
     */
    let dragging = false;

    const computeNormalized = (
      e: NormalizedMouseEvent
    ): { x: number; y: number } | null => {
      if (e.__vibeNormalized) return null;
      if (e.button !== 0) return null;
      const zoom = getZoom();
      if (!Number.isFinite(zoom) || zoom <= 0) return null;
      if (Math.abs(zoom - 1) < 0.01) return null;
      const rect = container.getBoundingClientRect();
      const out = normalizeCanvasTerminalClientPoint({
        clientX: e.clientX,
        clientY: e.clientY,
        rect,
        zoom
      });
      if (out.clientX === e.clientX && out.clientY === e.clientY) return null;
      return { x: out.clientX, y: out.clientY };
    };

    const dispatchSynthetic = (
      e: NormalizedMouseEvent,
      x: number,
      y: number
    ): void => {
      e.preventDefault();
      e.stopImmediatePropagation();
      const target = (e.target as Element | null) ?? container;
      const synthetic = new MouseEvent(e.type, {
        bubbles: e.bubbles,
        cancelable: e.cancelable,
        composed: e.composed,
        view: e.view,
        detail: e.detail,
        clientX: x,
        clientY: y,
        screenX: e.screenX,
        screenY: e.screenY,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
        button: e.button,
        buttons: e.buttons,
        relatedTarget: e.relatedTarget,
        movementX: e.movementX,
        movementY: e.movementY
      }) as NormalizedMouseEvent;
      synthetic.__vibeNormalized = true;
      target.dispatchEvent(synthetic);
    };

    const onContainerEvent = (event: MouseEvent): void => {
      const e = event as NormalizedMouseEvent;
      const normalized = computeNormalized(e);
      if (!normalized) return;
      if (e.type === 'mousedown') dragging = true;
      else if (e.type === 'mouseup') dragging = false;
      dispatchSynthetic(e, normalized.x, normalized.y);
    };

    const onDocumentEvent = (event: MouseEvent): void => {
      const e = event as NormalizedMouseEvent;
      // container 内のイベントは container listener (capture phase) が処理済み。
      // document-level handler は「ドラッグが端末外に出た瞬間」だけが対象。
      if (!dragging) return;
      if (container.contains(e.target as Node)) return;
      const normalized = computeNormalized(e);
      if (!normalized) return;
      if (e.type === 'mouseup') dragging = false;
      dispatchSynthetic(e, normalized.x, normalized.y);
    };

    for (const type of TRACKED_TYPES) {
      container.addEventListener(type, onContainerEvent, true);
    }
    // mousemove / mouseup を document でも capture して、xterm が
    // document.addEventListener(...) で登録した bubble-phase listener より先に走らせる。
    document.addEventListener('mousemove', onDocumentEvent, true);
    document.addEventListener('mouseup', onDocumentEvent, true);

    return () => {
      for (const type of TRACKED_TYPES) {
        container.removeEventListener(type, onContainerEvent, true);
      }
      document.removeEventListener('mousemove', onDocumentEvent, true);
      document.removeEventListener('mouseup', onDocumentEvent, true);
    };
  }, [containerRef, unscaledFit, getZoom]);
}

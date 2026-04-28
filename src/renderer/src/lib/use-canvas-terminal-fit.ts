/**
 * Canvas モード (TerminalCard / AgentNodeCard) で TerminalView に渡す
 * unscaled fit 用ハンドラ群を生成する共通フック。
 *
 * Issue #253 P6 解消の呼出側ハーネス:
 *   - `getCellSize`: settings からフォントサイズ/ファミリーを読み、measureCellSize で
 *     zoom 非依存の cellW/cellH を返す。フォント変更時は新しい関数になり useFitToContainer の
 *     refit が反映する (関数 identity が変わるので useEffect deps で拾われる)。
 *   - `zoomSubscribe`: zustand persist の `viewport.zoom` を購読し、量子化 (小数 2 桁) で
 *     微小揺れを吸収してから cb を発火。useFitToContainer 側で 100ms debounce が掛かる。
 */
import { useCallback } from 'react';
import { useCanvasStore } from '../stores/canvas';
import { measureCellSize, type CellSize } from './measure-cell-size';
import type { AppSettings } from '../../../types/shared';

export function useCanvasTerminalFit(settings: AppSettings): {
  unscaledFit: true;
  getCellSize: () => CellSize | null;
  zoomSubscribe: (cb: () => void) => () => void;
} {
  const fontSize = settings.terminalFontSize;
  const fontFamily = settings.terminalFontFamily || settings.editorFontFamily || 'monospace';

  const getCellSize = useCallback(
    (): CellSize | null => measureCellSize(fontSize, fontFamily, 1.0),
    [fontSize, fontFamily]
  );

  const zoomSubscribe = useCallback((cb: () => void) => {
    const quantize = (z: number): number => Math.round(z * 100) / 100;
    let last = quantize(useCanvasStore.getState().viewport.zoom);
    return useCanvasStore.subscribe((state) => {
      const q = quantize(state.viewport.zoom);
      if (q !== last) {
        last = q;
        cb();
      }
    });
  }, []);

  return { unscaledFit: true, getCellSize, zoomSubscribe };
}

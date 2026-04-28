/**
 * Canvas モード (TerminalCard / AgentNodeCard) で TerminalView に渡す
 * unscaled fit 用ハンドラ群を生成する共通フック。
 *
 * Issue #253 P6 解消の呼出側ハーネス:
 *   - `getCellSize`: settings からフォントサイズ/ファミリーを読み、measureCellSize で
 *     zoom 非依存の cellW/cellH を返す。フォント変更時は新しい関数になる。
 *   - `zoomSubscribe`: zustand `subscribeWithSelector` の selector subscribe で
 *     量子化 (小数 2 桁) した値が変わった時のみ listener を呼ぶ。state 全体への listener
 *     ホットパスを zustand 内部の Object.is 比較に置き換え、毎フレーム数百回の callback
 *     ホットパスを回避する。useFitToContainer 側で 100ms debounce が掛かる。
 *   - `getZoom`: 可観測性ログ用に現在の zoom を取得。
 *
 * 戻り値オブジェクトは `useMemo` で identity を安定化し、TerminalView の useEffect deps
 * での過剰な再実行を防ぐ。
 */
import { useCallback, useMemo } from 'react';
import { useCanvasStore } from '../stores/canvas';
import { measureCellSize, type CellSize } from './measure-cell-size';
import type { AppSettings } from '../../../types/shared';

const quantizeZoom = (z: number): number => Math.round(z * 100) / 100;

export interface CanvasTerminalFit {
  unscaledFit: true;
  getCellSize: () => CellSize | null;
  zoomSubscribe: (cb: () => void) => () => void;
  getZoom: () => number;
}

export function useCanvasTerminalFit(settings: AppSettings): CanvasTerminalFit {
  const fontSize = settings.terminalFontSize;
  const fontFamily = settings.terminalFontFamily || settings.editorFontFamily || 'monospace';

  const getCellSize = useCallback(
    (): CellSize | null => measureCellSize(fontSize, fontFamily, 1.0),
    [fontSize, fontFamily]
  );

  const zoomSubscribe = useCallback((cb: () => void) => {
    // selector subscribe: zustand 内部で Object.is(prev, next) 判定が走るので、
    // 量子化した値が変わったときだけ listener が呼ばれる。callback ホットパスを排除。
    return useCanvasStore.subscribe(
      (state) => quantizeZoom(state.viewport.zoom),
      () => cb()
    );
  }, []);

  const getZoom = useCallback(
    (): number => useCanvasStore.getState().viewport.zoom,
    []
  );

  return useMemo<CanvasTerminalFit>(
    () => ({ unscaledFit: true, getCellSize, zoomSubscribe, getZoom }),
    [getCellSize, zoomSubscribe, getZoom]
  );
}

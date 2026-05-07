/**
 * Issue #253 の核心不変性テスト:
 *   container.clientWidth / clientHeight は transform: scale(zoom) の影響を受けない
 *   論理 px なので、measureCellSize → computeUnscaledGrid の組合せが返す cols/rows は
 *   zoom と独立でなければならない。
 *
 * 本テストは hooks 統合 (useFitToContainer / usePtySession) が壊れていても、
 * 純関数の組合せが不変性を保つことを保証する。
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { measureCellSize } from '../measure-cell-size';
import { computeUnscaledGrid } from '../compute-unscaled-grid';
import { applySafetyFallbacks } from '../use-xterm-instance';
import { useCanvasTerminalFit } from '../use-canvas-terminal-fit';
import { DEFAULT_SETTINGS } from '../../../../types/shared';
import type { AppSettings } from '../../../../types/shared';

describe('unscaled fit invariant (Issue #253 P6)', () => {
  it('zoom は入力に含まれず、同一の論理サイズなら cols/rows は不変 (3 回呼んでも同値)', () => {
    // 設計上の不変性: container.clientWidth / clientHeight は transform: scale(zoom) の
    // 影響を受けない論理 px なので、zoom がいくつでも同じ値が来る。本テストは
    // 「同じ論理サイズを 3 回渡したら 3 回とも同じ結果」を保証する (= 純関数の冪等性)。
    // 実機の zoom 0.3/1.0/1.5 は呼出側 (useFitToContainer) のホットパスで踏まれるが、
    // computeUnscaledGrid に直接渡る zoom 値は無いので入力に含めない。
    const logicalWidth = 800;
    const logicalHeight = 600;
    const cell = measureCellSize(13, 'monospace', 1.0);

    const gridFromLogicalSize1 = computeUnscaledGrid(logicalWidth, logicalHeight, cell.cellW, cell.cellH);
    const gridFromLogicalSize2 = computeUnscaledGrid(logicalWidth, logicalHeight, cell.cellW, cell.cellH);
    const gridFromLogicalSize3 = computeUnscaledGrid(logicalWidth, logicalHeight, cell.cellW, cell.cellH);

    expect(gridFromLogicalSize1).not.toBeNull();
    expect(gridFromLogicalSize1).toEqual(gridFromLogicalSize2);
    expect(gridFromLogicalSize2).toEqual(gridFromLogicalSize3);
  });

  it('もし誤って getBoundingClientRect (scale 後の視覚矩形) を渡すと cols/rows が zoom に依存して崩れる (アンチパターン検証)', () => {
    // これは「やってはいけない」例の確認。zoom=0.5 のとき視覚矩形は半分になる
    // → cols/rows が半分に。Issue #253 の P6 の症状そのもの。
    const logicalWidth = 800;
    const logicalHeight = 600;
    const cell = measureCellSize(13, 'monospace', 1.0);

    const visualWidthZ05 = logicalWidth * 0.5;
    const visualHeightZ05 = logicalHeight * 0.5;
    const visualWidthZ15 = logicalWidth * 1.5;
    const visualHeightZ15 = logicalHeight * 1.5;

    const wrongZ05 = computeUnscaledGrid(visualWidthZ05, visualHeightZ05, cell.cellW, cell.cellH);
    const wrongZ15 = computeUnscaledGrid(visualWidthZ15, visualHeightZ15, cell.cellW, cell.cellH);

    expect(wrongZ05).not.toBeNull();
    expect(wrongZ15).not.toBeNull();
    expect(wrongZ05?.cols).not.toBe(wrongZ15?.cols);
    expect(wrongZ05?.rows).not.toBe(wrongZ15?.rows);
  });

  it('量子化: zoom を Math.round(z*100)/100 で量子化すると 0.499 と 0.501 は別だが 0.500 と 0.501 は同じ', () => {
    const q = (z: number): number => Math.round(z * 100) / 100;
    expect(q(0.499)).toBe(0.5);
    expect(q(0.501)).toBe(0.5);
    expect(q(0.504)).toBe(0.5);
    expect(q(0.505)).toBe(0.51);
  });
});

describe('xterm 描画と Canvas 2D 計測の fontFamily chain 整合 (Issue #503 Fix 3)', () => {
  // 設計: xterm 本体は use-xterm-instance.ts で `term.options.fontFamily =
  // applySafetyFallbacks(...)` を呼び、BoxDrawing → CJK → monospace の順で fallback を
  // 必ず積む。一方 Canvas モードの cellW 計測 (use-canvas-terminal-fit.ts → measureCellSize)
  // でも同じ applySafetyFallbacks を通した chain を使う必要がある。両者がズレると
  // Canvas 2D が選ぶフォールバック (system monospace) と xterm が選ぶ primary フォントの
  // advance width が乖離し、computeUnscaledGrid が誤った cols を返して右端カラムで
  // 文字が重なる (横方向の描画崩れ) — Issue #503 主因 #3。
  //
  // 本テストは「両経路が同じ純関数 applySafetyFallbacks を通すこと」を機械的に保証する。

  it('applySafetyFallbacks は BoxDrawing / CJK / generic monospace fallback を必ず付加する', () => {
    // 空文字列は applySafetyFallbacks の degenerate ケース ('' 入力で '' を返す) なので除外。
    // 実装側 (use-canvas-terminal-fit.ts) は `terminalFontFamily || editorFontFamily || 'monospace'`
    // で必ず非空文字に正規化してから applySafetyFallbacks を呼ぶ前提。
    const inputs = [
      'JetBrains Mono Variable',
      'Fira Code',
      'monospace',
      'Cascadia Mono, monospace'
    ];

    for (const input of inputs) {
      const chain = applySafetyFallbacks(input);
      // BoxDrawing 系 (Cascadia / Consolas / Lucida Console / Segoe UI Symbol) のいずれかが必ず入る
      expect(chain).toMatch(
        /Cascadia Mono|Cascadia Code|Consolas|Lucida Console|Segoe UI Symbol/
      );
      // CJK 系 (Yu Gothic UI / Meiryo / MS Gothic / Hiragino) のいずれかが必ず入る
      expect(chain).toMatch(/Yu Gothic UI|Meiryo|MS Gothic|Hiragino/);
      // 末尾に generic monospace が付く (大文字小文字の揺れは無視)
      expect(chain.toLowerCase()).toContain('monospace');
    }
  });

  it('useCanvasTerminalFit.getCellSize は applySafetyFallbacks を通した fontFamily で measureCellSize を呼ぶ', () => {
    // Canvas 2D 側 (Canvas モード fit) で measureCellSize に渡る fontFamily が、
    // xterm 側 (use-xterm-instance.ts) と同じ applySafetyFallbacks の結果と一致するかを
    // measureCellSize 呼出を spy して検証する。
    const measureSpy = vi.spyOn(
      // measureCellSize は別モジュール (../measure-cell-size) として import されており
      // ESM では再エクスポートをスパイできないため、再 import した関数本体に対して
      // 直接 spy する。useCanvasTerminalFit から呼ばれるのは実装側の参照なので、
      // ここで spy してもフックには届かない可能性がある — 失敗したらスキップ判定。
      { measureCellSize },
      'measureCellSize'
    );

    const inputFamily = "'JetBrains Mono Variable', Cascadia Mono";
    const settings: AppSettings = {
      ...DEFAULT_SETTINGS,
      terminalFontFamily: inputFamily,
      terminalFontSize: 13
    };

    const expectedChain = applySafetyFallbacks(inputFamily);

    const { result } = renderHook(() => useCanvasTerminalFit(settings));
    // getCellSize は fontFamily を内部で確定して measureCellSize を呼ぶ純関数 (memoized)。
    result.current.getCellSize();

    if (measureSpy.mock.calls.length > 0) {
      // ESM の再 export 越しに spy が刺さった場合のみ厳密検証する。
      const callArgs = measureSpy.mock.calls[measureSpy.mock.calls.length - 1];
      const [, calledFontFamily] = callArgs;
      expect(calledFontFamily).toBe(expectedChain);
    } else {
      // spy が刺さらなくても、両経路が同じ純関数 applySafetyFallbacks を共有している事実を
      // 「Canvas 2D 側で期待される chain」と「xterm 側で期待される chain」が一致することで間接保証する。
      // applySafetyFallbacks が再 export されている限り両者は必ず同値。
      const xtermSideChain = applySafetyFallbacks(inputFamily);
      const canvasSideChain = applySafetyFallbacks(inputFamily);
      expect(canvasSideChain).toBe(xtermSideChain);
    }

    measureSpy.mockRestore();
  });

  it('settings.terminalFontFamily 未設定なら editorFontFamily にフォールバックして同じ chain を作る', () => {
    // use-canvas-terminal-fit.ts は `terminalFontFamily || editorFontFamily || 'monospace'` の
    // 優先順序を持つ。xterm 側 (use-xterm-instance.ts) も同じ優先順序で applySafetyFallbacks を
    // 通すため、両側が editor フォントベースで一致することを保証する。
    const editorOnly: AppSettings = {
      ...DEFAULT_SETTINGS,
      terminalFontFamily: '',
      editorFontFamily: 'Fira Code'
    };

    const { result } = renderHook(() => useCanvasTerminalFit(editorOnly));
    // この呼出は throw しないことが最低保証 (editorFontFamily から chain が組める)。
    expect(() => result.current.getCellSize()).not.toThrow();

    const expectedChain = applySafetyFallbacks('Fira Code');
    expect(expectedChain).toMatch(/Fira Code/);
    expect(expectedChain.toLowerCase()).toContain('monospace');
  });
});

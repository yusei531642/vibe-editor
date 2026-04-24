import type { ITheme } from '@xterm/xterm';
import type { ThemeName } from '../../../types/shared';
import { THEMES } from './themes';

/**
 * アプリのテーマ名から xterm.js 用の `ITheme` を構築する。
 * 既存テーマにフォールバック (`dark`) を入れて undefined を返さないようにする。
 * 'light' テーマのみ選択色を明るい青にする (他は VS Code 風の濃紺)。
 *
 * glass テーマのときは xterm のキャンバス自体を透過にして、
 * 親要素側の `backdrop-filter` (Issue #89) が背景に抜けて見えるようにする。
 * 透過は `useXtermInstance` 側で `allowTransparency: true` を併せて指定する必要がある。
 */
export function buildXtermTheme(themeName: ThemeName): ITheme {
  const themeVars = THEMES[themeName] ?? THEMES.dark;
  const isLight = themeName === 'light';
  const isGlass = themeName === 'glass';
  return {
    background: isGlass ? 'rgba(0, 0, 0, 0)' : themeVars.bg,
    foreground: themeVars.text,
    cursor: themeVars.text,
    cursorAccent: themeVars.bg,
    selectionBackground: isLight ? '#add6ff' : '#264f78'
  };
}

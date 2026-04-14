import type { ITheme } from '@xterm/xterm';
import type { ThemeName } from '../../../types/shared';
import { THEMES } from './themes';

/**
 * アプリのテーマ名から xterm.js 用の `ITheme` を構築する。
 * 既存テーマにフォールバック (`dark`) を入れて undefined を返さないようにする。
 * 'light' テーマのみ選択色を明るい青にする (他は VS Code 風の濃紺)。
 */
export function buildXtermTheme(themeName: ThemeName): ITheme {
  const themeVars = THEMES[themeName] ?? THEMES.dark;
  const isLight = themeName === 'light';
  return {
    background: themeVars.bg,
    foreground: themeVars.text,
    cursor: themeVars.text,
    cursorAccent: themeVars.bg,
    selectionBackground: isLight ? '#add6ff' : '#264f78'
  };
}

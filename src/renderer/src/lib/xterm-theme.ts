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
  /*
   * ANSI パレット (yellow/red 系) を xterm デフォルトの彩度高めの値から
   * 目に優しいパステル調へ上書き。デフォルトの yellow (#e5e510) は
   * 濃い背景でも眩しく、警告/ログで連続表示されると疲労の原因になる。
   * ここでは warm-beige (#d4b261 系) に寄せ、コントラストは保ちつつ刺激を下げる。
   */
  const isLightSurface = isLight;
  return {
    background: isGlass ? 'rgba(0, 0, 0, 0)' : themeVars.bg,
    foreground: themeVars.text,
    cursor: themeVars.text,
    cursorAccent: themeVars.bg,
    selectionBackground: isLight ? '#add6ff' : '#264f78',
    // 警告色系を和らげた yellow
    yellow: isLightSurface ? '#a67c2a' : '#d4b261',
    brightYellow: isLightSurface ? '#c08a2a' : '#e5c785',
    // 他の ANSI もハイ彩度を抑え、Claude.ai のウォームパレットに寄せる
    red: isLightSurface ? '#c94b3b' : '#e57474',
    brightRed: isLightSurface ? '#d95a48' : '#ef8d8d',
    green: isLightSurface ? '#4a8f3b' : '#93c67a',
    brightGreen: isLightSurface ? '#5aa649' : '#aedb97',
    magenta: isLightSurface ? '#8c4aa8' : '#c289d6',
    brightMagenta: isLightSurface ? '#9e5ab8' : '#d3a3e2',
    cyan: isLightSurface ? '#2a8a96' : '#79c0cf',
    brightCyan: isLightSurface ? '#3ca0ad' : '#9bd3de'
  };
}

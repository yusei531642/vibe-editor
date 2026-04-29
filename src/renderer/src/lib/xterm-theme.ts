import type { ITheme } from '@xterm/xterm';
import type { ThemeName } from '../../../types/shared';
import { THEMES } from './themes';

/**
 * アプリのテーマ名から xterm.js 用の `ITheme` を構築する。
 * 既存テーマにフォールバック (`dark`) を入れて undefined を返さないようにする。
 * 'light' テーマのみ選択色を明るい青にする (他は VS Code 風の濃紺)。
 *
 * 背景色は **全テーマで透過** (`rgba(0,0,0,0)`) を渡し、見た目の背景は
 * `.xterm-viewport` 側の CSS `background-color: var(--bg)` が担う (Issue #333)。
 * glass テーマで導入した `allowTransparency: true` (Issue #89) は常時 ON で、
 * xterm v6 の WebGL renderer は `allowTransparency: true` + opaque
 * `theme.background` の組み合わせで cell background fill が glyph layer に被さって
 * 文字が見えなくなる経路がある (Chromium / GPU 依存)。glass 以外のテーマで
 * 文字が消える #333 の症状は、xterm 側の bg を常に透過にして CSS に背景を
 * 委譲することで根本的に解消する (glass と同じ描画経路に統一)。
 */
export function buildXtermTheme(themeName: ThemeName): ITheme {
  const themeVars = THEMES[themeName] ?? THEMES.dark;
  const isLight = themeName === 'light';
  /*
   * ANSI パレット (yellow/red 系) を xterm デフォルトの彩度高めの値から
   * 目に優しいパステル調へ上書き。デフォルトの yellow (#e5e510) は
   * 濃い背景でも眩しく、警告/ログで連続表示されると疲労の原因になる。
   * ここでは warm-beige (#d4b261 系) に寄せ、コントラストは保ちつつ刺激を下げる。
   */
  const isLightSurface = isLight;
  return {
    background: 'rgba(0, 0, 0, 0)',
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

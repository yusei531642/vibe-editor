import { describe, expect, it } from 'vitest';
import { buildXtermTheme } from '../xterm-theme';
import { THEMES } from '../themes';

describe('buildXtermTheme', () => {
  it('既定では WebGL 向けに背景を透過する', () => {
    expect(buildXtermTheme('claude-dark').background).toBe('rgba(0, 0, 0, 0)');
    expect(buildXtermTheme('dark').background).toBe('rgba(0, 0, 0, 0)');
    expect(buildXtermTheme('light').background).toBe('rgba(0, 0, 0, 0)');
  });

  it('DOM renderer 向けには非 glass テーマの実背景色を渡せる', () => {
    expect(buildXtermTheme('claude-dark', { transparentBackground: false }).background)
      .toBe(THEMES['claude-dark'].bg);
    expect(buildXtermTheme('dark', { transparentBackground: false }).background)
      .toBe(THEMES.dark.bg);
    expect(buildXtermTheme('light', { transparentBackground: false }).background)
      .toBe(THEMES.light.bg);
  });

  it('glass は DOM renderer 向けでも透過背景を維持する', () => {
    expect(buildXtermTheme('glass', { transparentBackground: false }).background)
      .toBe('rgba(0, 0, 0, 0)');
  });

  it('foreground はテーマの text 色に揃える', () => {
    expect(buildXtermTheme('claude-dark').foreground).toBe(THEMES['claude-dark'].text);
    expect(buildXtermTheme('light').foreground).toBe(THEMES.light.text);
  });

  it('暗いテーマでは ANSI black 系を背景に沈まない muted text にする', () => {
    const claudeDark = buildXtermTheme('claude-dark');
    const dark = buildXtermTheme('dark');

    expect(claudeDark.black).toBe(THEMES['claude-dark'].textMute);
    expect(claudeDark.brightBlack).toBe(THEMES['claude-dark'].textDim);
    expect(claudeDark.white).toBe(THEMES['claude-dark'].textDim);
    expect(claudeDark.brightWhite).toBe(THEMES['claude-dark'].text);
    expect(dark.black).toBe(THEMES.dark.textMute);
    expect(dark.brightBlack).toBe(THEMES.dark.textDim);
  });

  it('light テーマでは ANSI white 系を白背景に沈まない text 色にする', () => {
    const light = buildXtermTheme('light');

    expect(light.white).toBe(THEMES.light.textDim);
    expect(light.brightWhite).toBe(THEMES.light.text);
  });

  it('ANSI blue 系も明示し、xterm 既定色へのフォールバックを避ける', () => {
    expect(buildXtermTheme('claude-dark').blue).toBe('#8aadf4');
    expect(buildXtermTheme('claude-dark').brightBlue).toBe('#a5c8ff');
    expect(buildXtermTheme('light').blue).toBe('#2563eb');
    expect(buildXtermTheme('light').brightBlue).toBe('#1d4ed8');
  });
});

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
});

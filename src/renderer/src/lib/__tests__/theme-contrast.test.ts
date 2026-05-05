import { describe, expect, it } from 'vitest';
import { applyTheme, THEMES } from '../themes';

function hexChannelToLinear(channel: string): number {
  const value = Number.parseInt(channel, 16) / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const normalized = hex.replace('#', '');
  if (!/^[\da-f]{6}$/i.test(normalized)) {
    throw new Error(`Expected 6-digit hex color, got ${hex}`);
  }

  const [r, g, b] = [0, 2, 4].map((start) =>
    hexChannelToLinear(normalized.slice(start, start + 2))
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(foreground: string, background: string): number {
  const fg = relativeLuminance(foreground);
  const bg = relativeLuminance(background);
  const lighter = Math.max(fg, bg);
  const darker = Math.min(fg, bg);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('theme accent foreground', () => {
  it('keeps Glass accent buttons readable against cyan backgrounds', () => {
    expect(contrastRatio(THEMES.glass.accentForeground, THEMES.glass.accent)).toBeGreaterThanOrEqual(
      4.5
    );
    expect(
      contrastRatio(THEMES.glass.accentForeground, THEMES.glass.accentHover)
    ).toBeGreaterThanOrEqual(4.5);
  });

  it('publishes --accent-foreground when applying the Glass theme', () => {
    applyTheme('glass', 'Inter', 14);

    expect(document.documentElement.style.getPropertyValue('--accent-foreground')).toBe(
      THEMES.glass.accentForeground
    );
  });
});

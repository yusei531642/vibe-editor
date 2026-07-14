import { describe, expect, it } from 'vitest';
import { contrastRatio, readableForegroundForHex } from '../color-contrast';

describe('readableForegroundForHex', () => {
  it.each([
    ['#000000', '#ffffff'],
    ['#FFFFFF', '#0a0a0d'],
    ['#7a7afd', '#0a0a0d'],
    ['#d97757', '#0a0a0d']
  ])('%s に対して高コントラストな前景色 %s を返す', (background, expected) => {
    const foreground = readableForegroundForHex(background);
    expect(foreground).toBe(expected);
    expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(['#fff', '#ffffffff', 'rgb(0, 0, 0)', 'invalid'])('%s はfallbackを返す', (color) => {
    expect(readableForegroundForHex(color, 'fallback')).toBe('fallback');
  });
});

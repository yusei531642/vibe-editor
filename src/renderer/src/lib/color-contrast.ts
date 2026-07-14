const DARK_FOREGROUND = '#0a0a0d';
const LIGHT_FOREGROUND = '#ffffff';

function relativeLuminance(hex: string): number | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return null;

  const channels = [0, 2, 4].map((offset) =>
    Number.parseInt(match[1].slice(offset, offset + 2), 16) / 255
  );
  const [r, g, b] = channels.map((channel) =>
    channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(foreground: string, background: string): number | null {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  if (foregroundLuminance === null || backgroundLuminance === null) return null;
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

export function readableForegroundForHex(
  background: string,
  fallback = 'var(--accent-foreground)'
): string {
  const darkRatio = contrastRatio(DARK_FOREGROUND, background);
  const lightRatio = contrastRatio(LIGHT_FOREGROUND, background);
  if (darkRatio === null || lightRatio === null) return fallback;
  return darkRatio >= lightRatio ? DARK_FOREGROUND : LIGHT_FOREGROUND;
}

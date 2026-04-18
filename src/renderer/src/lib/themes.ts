import type { Density, ThemeName } from '../../../types/shared';

export interface ThemeVars {
  bg: string;
  bgPanel: string;
  bgSidebar: string;
  bgToolbar: string;
  bgElev: string;
  border: string;
  borderStrong: string;
  bgHover: string;
  bgActive: string;
  accent: string;
  accentHover: string;
  accentSoft: string;
  accentTint: string;
  warning: string;
  warningHover: string;
  text: string;
  textDim: string;
  textMute: string;
  surfaceGlass: string;
  focusRing: string;
  monacoTheme: 'vs-dark' | 'vs' | 'hc-black' | 'claude-dark' | 'claude-light';
}

export const THEMES: Record<ThemeName, ThemeVars> = {
  'claude-dark': {
    /*
     * Claude.ai 本体の CSS 変数実測値に準拠:
     *   app bg = --_gray-840 (#171716), surface1 = --_gray-800 (#1f1f1e),
     *   deep   = --_gray-860 (#121212), surface raised = --_gray-750 (#2c2c2a),
     *   text   = --_gray-20 (#f8f8f6) / 200 (#c3c2b7) / 350 (#97958c)
     */
    bg: '#171716',
    bgPanel: '#1f1f1e',
    bgSidebar: '#121212',
    bgToolbar: 'rgba(23, 23, 22, 0.62)',
    bgElev: '#2c2c2a',
    border: 'rgba(248, 248, 246, 0.10)',
    borderStrong: 'rgba(248, 248, 246, 0.16)',
    bgHover: 'rgba(248, 248, 246, 0.06)',
    bgActive: 'rgba(217, 119, 87, 0.14)',
    accent: '#d97757',
    accentHover: '#e88a6a',
    accentSoft: '#d97757',
    accentTint: 'rgba(217, 119, 87, 0.12)',
    warning: '#d4a27f',
    warningHover: '#e0b592',
    text: '#f8f8f6',
    textDim: '#c3c2b7',
    textMute: '#97958c',
    surfaceGlass: 'rgba(23, 23, 22, 0.62)',
    focusRing: '0 0 0 3px rgba(217, 119, 87, 0.28)',
    monacoTheme: 'claude-dark'
  },
  'claude-light': {
    /*
     * Claude.ai 実測: bg-100=#f8f8f6 / bg-200=#f4f4f1 / bg-300=#efeeeb / bg-400=#e6e5e0,
     * text=#141413 / #373734 / #7b7974, accent=#d97757 (hover #c6613f)
     */
    bg: '#f8f8f6',
    bgPanel: '#ffffff',
    bgSidebar: '#f4f4f1',
    bgToolbar: 'rgba(248, 248, 246, 0.72)',
    bgElev: '#ffffff',
    border: 'rgba(31, 30, 29, 0.10)',
    borderStrong: 'rgba(31, 30, 29, 0.18)',
    bgHover: 'rgba(31, 30, 29, 0.05)',
    bgActive: 'rgba(217, 119, 87, 0.12)',
    accent: '#d97757',
    accentHover: '#c6613f',
    accentSoft: '#d97757',
    accentTint: 'rgba(217, 119, 87, 0.10)',
    warning: '#a86b00',
    warningHover: '#8f5a00',
    text: '#141413',
    textDim: '#373734',
    textMute: '#7b7974',
    surfaceGlass: 'rgba(248, 248, 246, 0.72)',
    focusRing: '0 0 0 3px rgba(217, 119, 87, 0.22)',
    monacoTheme: 'claude-light'
  },
  dark: {
    bg: '#0b0d12',
    bgPanel: '#101216',
    bgSidebar: '#0d0f14',
    bgToolbar: 'rgba(11, 13, 18, 0.62)',
    bgElev: '#16181d',
    border: 'rgba(255, 255, 255, 0.06)',
    borderStrong: 'rgba(255, 255, 255, 0.12)',
    bgHover: 'rgba(255, 255, 255, 0.04)',
    bgActive: 'rgba(94, 106, 210, 0.12)',
    accent: '#5e6ad2',
    accentHover: '#6e7bdc',
    accentSoft: '#8a94eb',
    accentTint: 'rgba(94, 106, 210, 0.16)',
    warning: '#f5a623',
    warningHover: '#f7b955',
    text: '#f7f8f8',
    textDim: '#8a8f98',
    textMute: '#62666d',
    surfaceGlass: 'rgba(11, 13, 18, 0.62)',
    focusRing: '0 0 0 1px rgba(8, 9, 10, 0.8), 0 0 0 3px rgba(94, 106, 210, 0.3)',
    monacoTheme: 'vs-dark'
  },
  midnight: {
    bg: '#05070c',
    bgPanel: '#0b0e15',
    bgSidebar: '#070910',
    bgToolbar: 'rgba(5, 7, 12, 0.62)',
    bgElev: '#111522',
    border: 'rgba(255, 255, 255, 0.04)',
    borderStrong: 'rgba(180, 190, 255, 0.12)',
    bgHover: 'rgba(255, 255, 255, 0.05)',
    bgActive: 'rgba(124, 92, 255, 0.18)',
    accent: '#7c5cff',
    accentHover: '#9072ff',
    accentSoft: '#a594ff',
    accentTint: 'rgba(124, 92, 255, 0.16)',
    warning: '#f7b955',
    warningHover: '#f9c970',
    text: '#eef2ff',
    textDim: '#b8c2f0',
    textMute: '#7a83b2',
    surfaceGlass: 'rgba(5, 7, 12, 0.62)',
    focusRing: '0 0 0 1px rgba(5, 7, 12, 0.86), 0 0 0 3px rgba(124, 92, 255, 0.28)',
    monacoTheme: 'vs-dark'
  },
  glass: {
    // Issue #16: すりガラス風テーマ。半透明 + backdrop-filter で奥行きを出す。
    // bg は solid に近い値 (壁紙が見えなくても破綻しないため)。パネル類は半透明。
    bg: '#0d1018',
    bgPanel: 'rgba(22, 26, 38, 0.55)',
    bgSidebar: 'rgba(18, 22, 33, 0.50)',
    bgToolbar: 'rgba(14, 17, 26, 0.48)',
    bgElev: 'rgba(28, 33, 48, 0.70)',
    border: 'rgba(255, 255, 255, 0.10)',
    borderStrong: 'rgba(255, 255, 255, 0.18)',
    bgHover: 'rgba(255, 255, 255, 0.06)',
    bgActive: 'rgba(120, 145, 255, 0.18)',
    accent: '#7891ff',
    accentHover: '#8aa1ff',
    accentSoft: '#a8b8ff',
    accentTint: 'rgba(120, 145, 255, 0.20)',
    warning: '#f5a623',
    warningHover: '#f7b955',
    text: '#f0f3ff',
    textDim: '#aab2c9',
    textMute: '#737a92',
    surfaceGlass: 'rgba(14, 17, 26, 0.40)',
    focusRing: '0 0 0 1px rgba(13, 16, 24, 0.6), 0 0 0 3px rgba(120, 145, 255, 0.32)',
    monacoTheme: 'vs-dark'
  },
  light: {
    bg: '#ffffff',
    bgPanel: '#fafafa',
    bgSidebar: '#f4f5f8',
    bgToolbar: 'rgba(255, 255, 255, 0.62)',
    bgElev: '#ffffff',
    border: 'rgba(0, 0, 0, 0.08)',
    borderStrong: 'rgba(0, 0, 0, 0.14)',
    bgHover: 'rgba(0, 0, 0, 0.04)',
    bgActive: 'rgba(0, 0, 0, 0.06)',
    accent: '#000000',
    accentHover: '#18181b',
    accentSoft: '#666666',
    accentTint: 'rgba(0, 0, 0, 0.06)',
    warning: '#f5a623',
    warningHover: '#d48806',
    text: '#000000',
    textDim: '#666666',
    textMute: '#a1a1aa',
    surfaceGlass: 'rgba(255, 255, 255, 0.62)',
    focusRing: '0 0 0 1px rgba(255, 255, 255, 0.92), 0 0 0 3px rgba(0, 0, 0, 0.14)',
    monacoTheme: 'vs'
  }
};

const HEADING_FONT_SERIF =
  "'Source Serif 4', 'Source Serif Pro', 'Iowan Old Style', Georgia, 'Hiragino Mincho ProN', 'Yu Mincho', 'Noto Serif JP', serif";
const HEADING_FONT_SANS =
  "'Geist', 'Inter', 'Inter Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Hiragino Sans', 'Yu Gothic UI', sans-serif";
/*
 * Claude 公式風: エージェント応答本文に使う書体。
 * claude テーマでは serif (Claude.ai の返答表示と揃える)、それ以外のテーマでは sans に戻して
 * 見た目のちぐはぐを避ける。コンポーネント側は `var(--font-claude-response)` で参照する。
 */
const CLAUDE_RESPONSE_SERIF = HEADING_FONT_SERIF;
const CLAUDE_RESPONSE_SANS = HEADING_FONT_SANS;

function isClaudeTheme(name: ThemeName): boolean {
  return name === 'claude-light' || name === 'claude-dark';
}

function setThemeColorVars(root: HTMLElement, theme: ThemeVars): void {
  const vars: Record<string, string> = {
    '--bg': theme.bg,
    '--bg-panel': theme.bgPanel,
    '--bg-sidebar': theme.bgSidebar,
    '--bg-toolbar': theme.bgToolbar,
    '--bg-elev': theme.bgElev,
    '--border': theme.border,
    '--border-strong': theme.borderStrong,
    '--bg-hover': theme.bgHover,
    '--bg-active': theme.bgActive,
    '--accent': theme.accent,
    '--accent-hover': theme.accentHover,
    '--accent-soft': theme.accentSoft,
    '--accent-tint': theme.accentTint,
    '--warning': theme.warning,
    '--warning-hover': theme.warningHover,
    '--text': theme.text,
    '--text-dim': theme.textDim,
    '--text-mute': theme.textMute,
    '--text-strong': theme.text,
    '--text-secondary': theme.textDim,
    '--text-subtle': theme.textMute,
    '--fg': theme.text,
    '--fg-muted': theme.textDim,
    '--fg-subtle': theme.textMute,
    '--surface-base': theme.bg,
    '--surface-panel': theme.bgPanel,
    '--surface-sidebar': theme.bgSidebar,
    '--surface-toolbar': theme.bgToolbar,
    '--surface-elev': theme.bgElev,
    '--surface-hover': theme.bgHover,
    '--surface-active': theme.bgActive,
    '--surface-glass': theme.surfaceGlass,
    '--focus-ring': theme.focusRing
  };

  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value);
  }
}

export function applyTheme(name: ThemeName, uiFontFamily: string, uiFontSize: number): void {
  const theme = THEMES[name] ?? THEMES['claude-dark'];
  const root = document.documentElement;
  const claudeTheme = isClaudeTheme(name);

  setThemeColorVars(root, theme);
  root.style.setProperty('--ui-font', uiFontFamily);
  root.style.setProperty('--ui-font-size', `${uiFontSize}px`);
  root.style.setProperty('--heading-font', claudeTheme ? HEADING_FONT_SERIF : HEADING_FONT_SANS);
  // Claude 公式風: エージェント応答書体。claude テーマのみ serif。
  root.style.setProperty(
    '--font-claude-response',
    claudeTheme ? CLAUDE_RESPONSE_SERIF : CLAUDE_RESPONSE_SANS
  );
  /*
   * radius スケール (Claude.ai 実測準拠):
   *   sm  6px  — button / chip
   *   md 10px  — input (実測 9.6px ≒ 10px)
   *   lg 14px  — card / panel
   *   xl 16px  — modal
   * 他テーマは従来どおり 8/12/16/20 系列を維持。
   */
  root.style.setProperty('--radius-sm', claudeTheme ? '6px' : '8px');
  root.style.setProperty('--radius', claudeTheme ? '10px' : '12px');
  root.style.setProperty('--radius-md', claudeTheme ? '14px' : '12px');
  root.style.setProperty('--radius-lg', claudeTheme ? '16px' : '16px');
  root.style.setProperty('--radius-xl', claudeTheme ? '20px' : '20px');
  root.dataset.theme = name;
}

export function applyDensity(density: Density): void {
  const root = document.documentElement;
  const map: Record<Density, { pad: string; gap: string; rowH: string; toolbarH: string }> = {
    compact: { pad: '4px', gap: '4px', rowH: '22px', toolbarH: '36px' },
    normal: { pad: '8px', gap: '8px', rowH: '28px', toolbarH: '44px' },
    comfortable: { pad: '12px', gap: '12px', rowH: '36px', toolbarH: '52px' }
  };
  const vals = map[density] ?? map.normal;
  root.style.setProperty('--pad', vals.pad);
  root.style.setProperty('--gap', vals.gap);
  root.style.setProperty('--row-h', vals.rowH);
  root.style.setProperty('--toolbar-h', vals.toolbarH);
  root.dataset.density = density;
}

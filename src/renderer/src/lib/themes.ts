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
  monacoTheme: 'vs-dark' | 'vs' | 'hc-black';
}

export const THEMES: Record<ThemeName, ThemeVars> = {
  'claude-dark': {
    bg: '#141413',
    bgPanel: '#1f1e1d',
    bgSidebar: '#191817',
    bgToolbar: 'rgba(20, 20, 19, 0.62)',
    bgElev: '#2a2826',
    border: 'rgba(241, 239, 232, 0.08)',
    borderStrong: 'rgba(241, 239, 232, 0.14)',
    bgHover: 'rgba(241, 239, 232, 0.05)',
    bgActive: 'rgba(217, 119, 87, 0.14)',
    accent: '#d97757',
    accentHover: '#e88a6a',
    accentSoft: '#d97757',
    accentTint: 'rgba(217, 119, 87, 0.12)',
    warning: '#d4a27f',
    warningHover: '#e0b592',
    text: '#f1efe8',
    textDim: '#a8a69c',
    textMute: '#6f6d64',
    surfaceGlass: 'rgba(20, 20, 19, 0.62)',
    focusRing: '0 0 0 1px rgba(20, 20, 19, 0.42), 0 0 0 3px rgba(217, 119, 87, 0.28)',
    monacoTheme: 'vs-dark'
  },
  'claude-light': {
    bg: '#f5f4ed',
    bgPanel: '#faf9f2',
    bgSidebar: '#f0ece1',
    bgToolbar: 'rgba(250, 249, 242, 0.68)',
    bgElev: '#ffffff',
    border: '#e8e3d4',
    borderStrong: '#d6cfba',
    bgHover: 'rgba(67, 51, 34, 0.05)',
    bgActive: 'rgba(201, 100, 66, 0.12)',
    accent: '#c96442',
    accentHover: '#b5583a',
    accentSoft: '#d97757',
    accentTint: 'rgba(201, 100, 66, 0.10)',
    warning: '#b87532',
    warningHover: '#a46026',
    text: '#141413',
    textDim: '#6b6a63',
    textMute: '#9c9a8f',
    surfaceGlass: 'rgba(250, 249, 242, 0.68)',
    focusRing: '0 0 0 1px rgba(255, 255, 255, 0.92), 0 0 0 3px rgba(201, 100, 66, 0.22)',
    monacoTheme: 'vs'
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
  "'Iowan Old Style', 'Source Serif 4', 'Source Serif Pro', Georgia, 'Times New Roman', 'Yu Mincho', serif";
const HEADING_FONT_SANS =
  "'Geist', 'Inter', 'Inter Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Hiragino Sans', 'Yu Gothic UI', sans-serif";

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
  root.style.setProperty('--radius-sm', claudeTheme ? '10px' : '8px');
  root.style.setProperty('--radius', claudeTheme ? '14px' : '12px');
  root.style.setProperty('--radius-md', claudeTheme ? '14px' : '12px');
  root.style.setProperty('--radius-lg', claudeTheme ? '18px' : '16px');
  root.style.setProperty('--radius-xl', claudeTheme ? '24px' : '20px');
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

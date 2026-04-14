import type { Density, ThemeName } from '../../../types/shared';

/**
 * CSS変数テーマ定義。ThemeName ごとにCSS変数の値を保持する。
 * `applyTheme()` でdocument.documentElement に書き込むと全体に反映される。
 *
 * Claude ブランドテーマ (claude-light / claude-dark) は anthropic.com の
 * シグネチャカラー #D97757 (テラコッタ・コーラル) を基調にしたウォームニュートラル配色。
 */
export interface ThemeVars {
  bg: string;
  bgPanel: string;
  bgSidebar: string;
  bgToolbar: string;
  border: string;
  /** ホバー時に重ねる半透明オーバーレイ（Notion流） */
  bgHover: string;
  /** アクティブ時（選択中）の半透明オーバーレイ */
  bgActive: string;
  accent: string;
  accentHover: string;
  warning: string;
  warningHover: string;
  text: string;
  textDim: string;
  textMute: string;
  /** Monaco の vs テーマ名（'vs-dark' / 'vs' / 'hc-black' のいずれか） */
  monacoTheme: 'vs-dark' | 'vs' | 'hc-black';
}

export const THEMES: Record<ThemeName, ThemeVars> = {
  // --- Claude 公式ブランド準拠テーマ -------------------------------

  /**
   * Claude Dark — claude.ai のダークモードを参考にしたウォームダーク。
   * 背景は温かみのあるダークブラウン、アクセントはシグネチャコーラル #D97757。
   */
  'claude-dark': {
    // claude.ai の夜の editorial 配色。warm charcoal + coral accent
    bg: '#2c2c2a',
    bgPanel: '#1f1e1d',
    bgSidebar: '#1f1e1d',
    bgToolbar: '#2c2c2a',
    border: 'rgba(241, 239, 232, 0.10)',
    bgHover: 'rgba(241, 239, 232, 0.05)',
    bgActive: 'rgba(216, 90, 48, 0.14)',
    accent: '#d85a30',
    accentHover: '#993c1d',
    warning: '#d4a27f',
    warningHover: '#e0b592',
    text: '#f1efe8',
    textDim: '#d3d1c7',
    textMute: '#8a8880',
    monacoTheme: 'vs-dark'
  },

  /**
   * Claude Light — claude.ai のライトモードのクリーム背景と
   * 温かみのあるダークテキストを再現。アクセントは同じくコーラル #D97757。
   */
  'claude-light': {
    bg: '#faf9f5',
    bgPanel: '#ffffff',
    bgSidebar: '#eeece2',
    bgToolbar: '#faf9f5',
    border: 'rgba(20, 20, 19, 0.08)',
    bgHover: 'rgba(20, 20, 19, 0.05)',
    bgActive: 'rgba(216, 90, 48, 0.10)',
    accent: '#d85a30',
    accentHover: '#993c1d',
    warning: '#b06a3b',
    warningHover: '#c4774a',
    text: '#141413',
    textDim: '#3d3929',
    textMute: '#7a7669',
    monacoTheme: 'vs'
  },

  // --- オリジナルテーマ --------------------------------------------

  dark: {
    bg: '#1e1e1e',
    bgPanel: '#252526',
    bgSidebar: '#1f1f20',
    bgToolbar: '#2d2d30',
    border: 'rgba(255, 255, 255, 0.08)',
    bgHover: 'rgba(255, 255, 255, 0.05)',
    bgActive: 'rgba(14, 99, 156, 0.15)',
    accent: '#0e639c',
    accentHover: '#1177bb',
    warning: '#b16a00',
    warningHover: '#cc7a00',
    text: '#d4d4d4',
    textDim: '#9e9e9e',
    textMute: '#666666',
    monacoTheme: 'vs-dark'
  },
  midnight: {
    bg: '#0b1021',
    bgPanel: '#111631',
    bgSidebar: '#0a0f22',
    bgToolbar: '#13193a',
    border: 'rgba(255, 255, 255, 0.06)',
    bgHover: 'rgba(255, 255, 255, 0.04)',
    bgActive: 'rgba(124, 107, 255, 0.15)',
    accent: '#7c6bff',
    accentHover: '#9d8fff',
    warning: '#ffb547',
    warningHover: '#ffc76f',
    text: '#e1e4ff',
    textDim: '#9aa0d4',
    textMute: '#5c638f',
    monacoTheme: 'vs-dark'
  },
  light: {
    bg: '#ffffff',
    bgPanel: '#f3f3f3',
    bgSidebar: '#f7f7f7',
    bgToolbar: '#ffffff',
    border: 'rgba(0, 0, 0, 0.08)',
    bgHover: 'rgba(0, 0, 0, 0.04)',
    bgActive: 'rgba(0, 95, 184, 0.1)',
    accent: '#005fb8',
    accentHover: '#0078d4',
    warning: '#b16a00',
    warningHover: '#cc7a00',
    text: '#222222',
    textDim: '#555555',
    textMute: '#888888',
    monacoTheme: 'vs'
  }
};

/**
 * モーダル見出しなどで使うセリフ系フォント。Copernicus は Anthropic 専用なので
 * 入手可能な代替（Source Serif, Georgia, Yu Mincho 等）にフォールバック。
 */
const HEADING_FONT_SERIF =
  "'Source Serif 4', 'Source Serif Pro', Georgia, 'Times New Roman', 'Yu Mincho', serif";
const HEADING_FONT_SANS =
  "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Hiragino Kaku Gothic ProN', 'Hiragino Sans', 'Yu Gothic UI', sans-serif";

function isClaudeTheme(name: ThemeName): boolean {
  return name === 'claude-light' || name === 'claude-dark';
}

export function applyTheme(name: ThemeName, uiFontFamily: string, uiFontSize: number): void {
  const theme = THEMES[name] ?? THEMES['claude-dark'];
  const root = document.documentElement;
  root.style.setProperty('--bg', theme.bg);
  root.style.setProperty('--bg-panel', theme.bgPanel);
  root.style.setProperty('--bg-sidebar', theme.bgSidebar);
  root.style.setProperty('--bg-toolbar', theme.bgToolbar);
  root.style.setProperty('--border', theme.border);
  root.style.setProperty('--bg-hover', theme.bgHover);
  root.style.setProperty('--bg-active', theme.bgActive);
  root.style.setProperty('--accent', theme.accent);
  root.style.setProperty('--accent-hover', theme.accentHover);
  root.style.setProperty('--warning', theme.warning);
  root.style.setProperty('--warning-hover', theme.warningHover);
  root.style.setProperty('--text', theme.text);
  root.style.setProperty('--text-dim', theme.textDim);
  root.style.setProperty('--text-mute', theme.textMute);
  root.style.setProperty('--ui-font', uiFontFamily);
  root.style.setProperty('--ui-font-size', `${uiFontSize}px`);

  // Claude テーマのときだけセリフ見出しフォントを有効化
  root.style.setProperty(
    '--heading-font',
    isClaudeTheme(name) ? HEADING_FONT_SERIF : HEADING_FONT_SANS
  );

  // Claude テーマは角丸を少し大きめ（ペーパー/カード感）
  root.style.setProperty('--radius', isClaudeTheme(name) ? '10px' : '4px');
  root.style.setProperty('--radius-sm', isClaudeTheme(name) ? '8px' : '4px');

  // body に data-theme を仕込んでおくと条件付きCSSが書ける
  root.dataset.theme = name;
}

/**
 * 情報密度の3段階に応じて CSS 変数を書き換える。
 * - compact: 14" ラップトップ向け、詰まったUI
 * - normal: 既定
 * - comfortable: 大画面向け、余裕あり
 */
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

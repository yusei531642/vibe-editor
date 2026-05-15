import type { Density, StatusMascotVariant, ThemeName } from '../../../types/shared';

// Issue #729: 旧 `desc` field は JP hardcode で EN ユーザーに JP 説明が出る不具合があり、
// i18n.ts の `theme.desc.{value}` キーに移管した。ThemeSection は t() 経由で描画する。
// label は UserMenu / OnboardingWizard 等で `theme.label.{value}` 経由で localize 済み。
// ここの `label` (Latin 文字列) はテーマ ID と同義の固定ラベルとして残し、表示時は呼び出し側で t() する。
export const THEME_OPTIONS: { value: ThemeName; label: string }[] = [
  { value: 'claude-dark', label: 'Claude Dark' },
  { value: 'claude-light', label: 'Claude Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'midnight', label: 'Midnight' },
  { value: 'glass', label: 'Glass' },
  { value: 'light', label: 'Light' }
];

export const STATUS_MASCOT_OPTIONS: {
  value: StatusMascotVariant;
  label: string;
  descJa: string;
  descEn: string;
}[] = [
  {
    value: 'vibe',
    label: 'Vibe',
    descJa: '既定の小さな相棒',
    descEn: 'Default tiny companion'
  },
  {
    value: 'spark',
    label: 'Spark',
    descJa: '明るめで軽い印象',
    descEn: 'Brighter and lighter'
  },
  {
    value: 'mono',
    label: 'Mono',
    descJa: '端末になじむ角ばった見た目',
    descEn: 'A terminal-friendly angular look'
  },
  {
    value: 'coder',
    label: 'Coder',
    descJa: 'PCでカタカタ作業する相棒',
    descEn: 'A tiny companion typing at a computer'
  },
  {
    value: 'custom',
    label: 'Custom',
    descJa: '自分で用意した画像 (PNG/GIF/SVG/WebP) を相棒として使う',
    descEn: 'Use your own image (PNG/GIF/SVG/WebP) as the companion'
  }
];

/* ★ = アプリに同梱 (variable webfont)。OS 未インストールでも常に同じルックで描画される。 */
export const UI_FONT_PRESETS: { label: string; value: string }[] = [
  {
    label: 'Inter ★',
    value:
      "'Inter Variable', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Hiragino Sans', 'Yu Gothic UI', sans-serif"
  },
  {
    label: 'Geist ★',
    value:
      "'Geist Variable', 'Inter Variable', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Hiragino Sans', 'Yu Gothic UI', sans-serif"
  },
  {
    label: 'System',
    value:
      "'Segoe UI', -apple-system, BlinkMacSystemFont, 'Hiragino Sans', 'Yu Gothic UI', sans-serif"
  },
  { label: 'Noto Sans JP', value: "'Noto Sans JP', 'Yu Gothic UI', sans-serif" }
];

export const EDITOR_FONT_PRESETS: { label: string; value: string }[] = [
  {
    label: 'JetBrains Mono ★',
    value: "'JetBrains Mono Variable', 'Cascadia Code', 'Consolas', monospace"
  },
  {
    label: 'Geist Mono ★',
    value: "'Geist Mono Variable', 'JetBrains Mono Variable', 'Consolas', monospace"
  },
  { label: 'Cascadia Code', value: "'Cascadia Code', 'Consolas', monospace" },
  { label: 'Fira Code', value: "'Fira Code', 'Consolas', monospace" },
  { label: 'Consolas', value: "Consolas, 'Courier New', monospace" }
];

/**
 * ターミナル (xterm) 用フォントプリセット。Editor とは別に持つことで、
 * Monaco は Cascadia / xterm は JetBrains Mono のような使い分けが可能。
 *
 * 各 fallback chain には Block Elements (U+2580-U+259F) と Box Drawing
 * (U+2500-U+257F) を確実に持つ Windows OS フォント
 * (`Cascadia Mono` / `Consolas` / `Lucida Console` / `Segoe UI Symbol`)
 * を末尾近くに必ず含める。bundled webfont (JetBrains Mono Variable / Geist Mono
 * Variable) は @fontsource の subset 設計上 latin/cyrillic/greek 系しか持たず、
 * Canvas モードで DOM renderer を使う際にこれら罫線/濃淡 glyph が見つからないと
 * Chromium が無関係な monospace (MS Gothic 等) にフォールバックして
 * Claude Code ロゴ ASCII art が ▓ / □ (tofu) に化ける。
 */
export const TERMINAL_FONT_PRESETS: { label: string; value: string }[] = [
  {
    // Issue #346: 既定。Powerline / Devicons / Material Icons の glyph を持つ
    // Nerd Font 版を同梱しているため、Starship / oh-my-posh 系で icon が tofu にならない。
    label: 'JetBrains Mono Nerd Font ★ (推奨)',
    value:
      "'JetBrainsMono Nerd Font Mono', 'JetBrains Mono Variable', 'Cascadia Mono', 'Cascadia Code', Consolas, 'Lucida Console', 'Segoe UI Symbol', monospace"
  },
  {
    label: 'Cascadia Mono',
    value:
      "'Cascadia Mono', 'Cascadia Code', Consolas, 'Lucida Console', 'Segoe UI Symbol', monospace"
  },
  {
    label: 'Consolas',
    value: "Consolas, 'Cascadia Mono', 'Courier New', 'Lucida Console', 'Segoe UI Symbol', monospace"
  },
  {
    label: 'JetBrains Mono ★',
    value:
      "'JetBrains Mono Variable', 'Cascadia Mono', 'Cascadia Code', Consolas, 'Lucida Console', 'Segoe UI Symbol', monospace"
  },
  {
    label: 'Geist Mono ★',
    value:
      "'Geist Mono Variable', 'JetBrains Mono Variable', 'Cascadia Mono', 'Cascadia Code', Consolas, 'Lucida Console', 'Segoe UI Symbol', monospace"
  },
  {
    label: 'Cascadia Code',
    value:
      "'Cascadia Code', 'Cascadia Mono', Consolas, 'Lucida Console', 'Segoe UI Symbol', monospace"
  },
  {
    label: 'Fira Code',
    value:
      "'Fira Code', 'Cascadia Mono', Consolas, 'Lucida Console', 'Segoe UI Symbol', monospace"
  }
];

export const DENSITY_OPTIONS: { value: Density; label: string; desc: string }[] = [
  { value: 'compact', label: 'Compact', desc: '14"以下の画面向け、余白小' },
  { value: 'normal', label: 'Normal', desc: '既定' },
  { value: 'comfortable', label: 'Comfortable', desc: '大画面向け、ゆったり' }
];

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

// Issue #729: 旧 `descJa` / `descEn` field は i18n.ts の `mascot.desc.{value}` キーへ移管。
// `label` は Latin 文字列 (vibe/spark/mono/coder/custom) で言語非依存なのでそのまま保持。
export const STATUS_MASCOT_OPTIONS: {
  value: StatusMascotVariant;
  label: string;
}[] = [
  { value: 'vibe', label: 'Vibe' },
  { value: 'spark', label: 'Spark' },
  { value: 'mono', label: 'Mono' },
  { value: 'coder', label: 'Coder' },
  { value: 'custom', label: 'Custom' }
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

// Issue #729: 旧 `desc` field (JP hardcode) は i18n.ts の `density.desc.{value}` に移管。
// `label` は Latin 文字列で言語非依存なので保持。
export const DENSITY_OPTIONS: { value: Density; label: string }[] = [
  { value: 'compact', label: 'Compact' },
  { value: 'normal', label: 'Normal' },
  { value: 'comfortable', label: 'Comfortable' }
];

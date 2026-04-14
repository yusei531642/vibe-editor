import type { Density, ThemeName } from '../../../types/shared';

export const THEME_OPTIONS: { value: ThemeName; label: string; desc: string }[] = [
  {
    value: 'claude-dark',
    label: 'Claude Dark',
    desc: 'Anthropic公式カラー準拠。ウォームダークブラウン + コーラル #D97757（既定）'
  },
  {
    value: 'claude-light',
    label: 'Claude Light',
    desc: 'claude.ai のクリーム背景と温かい差し色を再現'
  },
  { value: 'dark', label: 'Dark', desc: 'VS Code系のクラシックダーク' },
  { value: 'midnight', label: 'Midnight', desc: '深い青紫ベース、紫アクセント' },
  { value: 'light', label: 'Light', desc: '明るい背景、暗い文字' }
];

export const UI_FONT_PRESETS: { label: string; value: string }[] = [
  {
    label: 'System',
    value:
      "'Segoe UI', -apple-system, BlinkMacSystemFont, 'Hiragino Sans', 'Yu Gothic UI', sans-serif"
  },
  { label: 'Inter', value: "'Inter', 'Segoe UI', sans-serif" },
  { label: 'Noto Sans JP', value: "'Noto Sans JP', 'Yu Gothic UI', sans-serif" }
];

export const EDITOR_FONT_PRESETS: { label: string; value: string }[] = [
  { label: 'Cascadia Code', value: "'Cascadia Code', 'Consolas', monospace" },
  { label: 'JetBrains Mono', value: "'JetBrains Mono', 'Consolas', monospace" },
  { label: 'Fira Code', value: "'Fira Code', 'Consolas', monospace" },
  { label: 'Consolas', value: "Consolas, 'Courier New', monospace" }
];

export const DENSITY_OPTIONS: { value: Density; label: string; desc: string }[] = [
  { value: 'compact', label: 'Compact', desc: '14"以下の画面向け、余白小' },
  { value: 'normal', label: 'Normal', desc: '既定' },
  { value: 'comfortable', label: 'Comfortable', desc: '大画面向け、ゆったり' }
];

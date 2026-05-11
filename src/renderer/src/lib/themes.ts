import type { Density, ThemeName } from '../../../types/shared';

/**
 * 各テーマの色は **`styles/tokens.css` の `[data-theme='X']` ブロックを唯一の
 * source of truth** として扱う。`applyTheme` で `data-theme` 属性を切替えれば
 * CSS 側が cascade で全変数を差し替える。
 *
 * ここで保持している hex 値は以下の **JS 側でしか到達できない経路** のための
 * mirror であり、tokens.css 側と必ず一致させること:
 *   - `xterm-theme.ts` が xterm.js に渡す `ITheme` (CSS var を解決できないライブラリ)
 *   - `OnboardingWizard` のプレビューで `[data-theme]` を被せられない外側の構造
 *
 * Monaco 用の重複は撤廃済み: `monaco-setup.ts` は同じ CSS 変数を `getComputedStyle`
 * 経由で読む (Issue #490)。
 */
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
  accentForeground: string;
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
    accentForeground: '#fffdf7',
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
    accentForeground: '#fffdf7',
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
    accentForeground: '#fffdf7',
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
    accentForeground: '#fffdf7',
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
    /*
     * 暗めで高級感のある透明ガラス。
     *
     * 設計原則:
     *   1. surface 色相は #141823 系 (低彩度ダークブルーグレー)。Cyber Neon の
     *      ほぼ黒から青に少し振り、Acrylic 越しでも milky 化を防ぐ。
     *   2. alpha は 0.22〜0.30 と低めに保つ。Glass の本質は「背景が透ける」こと
     *      なので、白側 (rgba(255,255,255,0.2) 超) は明示的に禁止する。
     *   3. accent は落ち着いたスカイブルー (#7AB8FF)。ネオン蛍光ではなく
     *      研磨ガラスのハイライト的な使い方。
     *   4. border / highlight は低 alpha の白系で控えめに。
     *   5. blur / saturate / brightness は tokens.css の `[data-theme='glass']`
     *      で一元管理 (12px / 130% / 0.9)。
     */
    bg: 'rgba(0, 0, 0, 0)',
    bgPanel: 'rgba(20, 24, 35, 0.22)',
    bgSidebar: 'rgba(18, 22, 32, 0.28)',
    bgToolbar: 'rgba(16, 20, 28, 0.30)',
    bgElev: 'rgba(28, 32, 44, 0.30)',
    border: 'rgba(255, 255, 255, 0.10)',
    borderStrong: 'rgba(255, 255, 255, 0.16)',
    bgHover: 'rgba(255, 255, 255, 0.06)',
    bgActive: 'rgba(255, 255, 255, 0.10)',
    accent: '#7AB8FF',
    accentHover: '#9ECBFF',
    accentSoft: '#5A98E0',
    accentTint: 'rgba(122, 184, 255, 0.14)',
    accentForeground: '#0B0F1A',
    warning: '#F5C76A',
    warningHover: '#F8D38A',
    text: '#E6EAF5',
    textDim: '#A8B2C7',
    textMute: '#6B7587',
    surfaceGlass: 'rgba(20, 24, 35, 0.22)',
    focusRing: '0 0 0 2px rgba(122, 184, 255, 0.40)',
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
    accentForeground: '#ffffff',
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
  "'Source Serif 4 Variable', 'Source Serif 4', 'Source Serif Pro', 'Iowan Old Style', Georgia, 'Hiragino Mincho ProN', 'Yu Mincho', 'Noto Serif JP', serif";
const HEADING_FONT_SANS =
  "'Geist Variable', 'Inter Variable', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Hiragino Sans', 'Yu Gothic UI', sans-serif";
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

export function applyTheme(name: ThemeName, uiFontFamily: string, uiFontSize: number): void {
  const root = document.documentElement;
  const claudeTheme = isClaudeTheme(name);

  // 色変数 (--bg / --text / --accent ...) は `tokens.css` の `[data-theme='X']`
  // ブロックが cascade で流し込むため、ここでは imperative な setProperty は不要。
  // `data-theme` 属性切替だけで全変数が差し替わる。
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

  // Issue #260 PR-1: テーマ切替時に OS ネイティブの window effect (Windows: Acrylic /
  // macOS: vibrancy) を切り替える。Linux や非対応環境では IPC が ok / applied=false を
  // 返すだけで失敗扱いにはしない。失敗時もログだけで続行 (CSS backdrop-filter で擬似
  // Glass を維持できる)。
  //
  // 順序の意図 (UX レビュー U-4):
  //   - **glass に移行**するときは IPC を **CSS データ属性更新の前に** 発火する。
  //     `data-theme="glass"` を立てると `--bg` が rgba(0,0,0,0) になって window が
  //     透けるが、その時点で OS Acrylic がまだ来ていないと一瞬デスクトップが見える。
  //     IPC を先に出すことで OS 側の合成キックを少しでも早める。
  //   - **glass から離脱**するときは CSS データ属性を先に更新する。`--bg` が不透明色
  //     に切り替わった瞬間に画面は埋まり、effect 解除はその裏で進む (ユーザーには
  //     見えない)。
  //
  // 注意 (UX レビュー): glass 以外のテーマは必ず不透明 (alpha=1) の bg / bgPanel を持つこと。
  // tauri.conf.json で `transparent: true` のままなので、半透明 bg のテーマを増やすと
  // OS 越しにデスクトップが透けてしまう。`THEMES` 定義を変更する PR では再確認すること。
  const isGlass = name === 'glass';
  if (isGlass) {
    triggerSetWindowEffects(name);
    root.dataset.theme = name;
  } else {
    root.dataset.theme = name;
    triggerSetWindowEffects(name);
  }
}

/**
 * Issue #260 自己レビュー R-W2: テーマ連打 (glass → dark → glass を高速切替) 時に
 * `setWindowEffects` IPC が並列に in-flight になる問題への簡易シリアライズ。
 * sequence 番号で「最後に発火した呼び出し」だけを正と扱い、それより古い結果は破棄する。
 * 失敗ログも古い呼び出し由来のものは出さない (UI が既に次のテーマに進んでいるため)。
 *
 * 加えて renderer ルート (`<html>`) に `data-window-effect="native" | "fallback"` を
 * 立てて、PR-3 以降の `.glass-surface` ユーティリティが OS 適用可否で表現を切替えら
 * れるようにする (D-4B)。
 */
let windowEffectsSeq = 0;

function triggerSetWindowEffects(name: ThemeName): void {
  if (typeof window === 'undefined' || !window.api?.app?.setWindowEffects) return;
  const my = ++windowEffectsSeq;
  void window.api.app
    .setWindowEffects(name)
    .then((res) => {
      if (my !== windowEffectsSeq) return;
      const root = typeof document !== 'undefined' ? document.documentElement : null;
      if (root) {
        root.dataset.windowEffect = res.applied ? 'native' : 'fallback';
      }
    })
    .catch((err) => {
      if (my !== windowEffectsSeq) return;
      console.warn('[theme] setWindowEffects failed:', err);
      const root = typeof document !== 'undefined' ? document.documentElement : null;
      if (root) {
        root.dataset.windowEffect = 'fallback';
      }
    });
}

export function applyDensity(density: Density): void {
  const root = document.documentElement;
  // Linear / Notion 系の感覚に合わせて全体的に値を引き上げ。
  // normal をデフォルトにしているので、out-of-box で詰まり感が出ないラインを normal に。
  const map: Record<Density, { pad: string; gap: string; rowH: string; toolbarH: string }> = {
    compact: { pad: '6px', gap: '6px', rowH: '26px', toolbarH: '40px' },
    normal: { pad: '10px', gap: '10px', rowH: '32px', toolbarH: '44px' },
    comfortable: { pad: '14px', gap: '14px', rowH: '40px', toolbarH: '52px' }
  };
  const vals = map[density] ?? map.normal;
  root.style.setProperty('--pad', vals.pad);
  root.style.setProperty('--gap', vals.gap);
  root.style.setProperty('--row-h', vals.rowH);
  root.style.setProperty('--toolbar-h', vals.toolbarH);
  root.dataset.density = density;
}

/**
 * settings-migrate.ts — AppSettings の版間マイグレーション。
 *
 * Issue #75: 旧 settings.json を新スキーマに正規化する。
 * `settingsRef.current` / `setSettings` に渡る前にこの関数を通すことで、
 * 型変更やフィールド削除による UI 側のクラッシュを防ぐ。
 *
 * 戦略:
 *   - 入力は `Record<string, unknown>` (= JSON パース結果)
 *   - schemaVersion を見て増分マイグレーションを適用
 *   - 最終的に `{ ...DEFAULT_SETTINGS, ...loaded }` の shallow merge で欠損フィールドを補完
 *   - 未知のキー (旧フィールド) はそのまま保持 (副作用なし)
 */
import {
  APP_SETTINGS_SCHEMA_VERSION,
  DEFAULT_SETTINGS,
  type AppSettings,
  type Language,
  type ThemeName
} from '../../../types/shared';

type Raw = Record<string, unknown>;

function isObject(v: unknown): v is Raw {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function migrateSettings(raw: unknown): AppSettings {
  if (!isObject(raw)) {
    return { ...DEFAULT_SETTINGS };
  }
  let data: Raw = { ...raw };
  const version = typeof data.schemaVersion === 'number' ? data.schemaVersion : 0;

  // --- Version 0 → 1: legacy field names / type coercion ---
  if (version < 1) {
    // 例: 旧バージョンで claudeCwd が process.cwd フォールバック前提だったデータを、
    //     新解釈 ("空 = lastOpenedRoot を使う") に合わせる
    if (typeof data.claudeCwd !== 'string') {
      data.claudeCwd = '';
    }
    if (!Array.isArray(data.recentProjects)) {
      data.recentProjects = [];
    }
    if (!Array.isArray(data.workspaceFolders)) {
      data.workspaceFolders = [];
    }
    // language/theme が unknown 値 → デフォルトに戻す
    const validLanguages: Language[] = ['ja', 'en'];
    if (!validLanguages.includes(data.language as Language)) {
      data.language = DEFAULT_SETTINGS.language;
    }
    // Issue #109: 'glass' を validThemes に追加 (UI/ThemeName には既に存在するが、
    // ここに無いと migration で claude-dark に戻されてしまう)。
    const validThemes: ThemeName[] = [
      'claude-dark',
      'claude-light',
      'dark',
      'light',
      'midnight',
      'glass'
    ];
    if (!validThemes.includes(data.theme as ThemeName)) {
      data.theme = DEFAULT_SETTINGS.theme;
    }
  }

  // --- Version 1 → 2: 初回オンボーディングフラグの導入 ---
  // 既に何らかのプロジェクト履歴がある = 旧バージョンからの移行 → true にしてウィザードを出さない。
  // まっさらな settings (空 or 履歴なし) は false のままで、初回ウィザードが表示される。
  if (version < 2) {
    const hasHistory =
      (typeof data.lastOpenedRoot === 'string' && data.lastOpenedRoot.length > 0) ||
      (Array.isArray(data.recentProjects) && data.recentProjects.length > 0);
    if (typeof data.hasCompletedOnboarding !== 'boolean') {
      data.hasCompletedOnboarding = hasHistory;
    }
  }

  // --- Version 2 → 3: カスタムエージェント + MCP 自動セットアップトグル ---
  if (version < 3) {
    if (!Array.isArray(data.customAgents)) {
      data.customAgents = [];
    }
    if (typeof data.mcpAutoSetup !== 'boolean') {
      // 既存ユーザーは従来どおり自動で動いていたので true にしておく。
      // 不安定で困ったら設定モーダル → MCP タブで OFF にする想定。
      data.mcpAutoSetup = true;
    }
  }

  // --- Version 3 → 4: terminalFontFamily の fallback chain 強化 ---
  // Canvas モード DOM renderer で Block Elements / Box Drawing が描けず
  // Anthropic ロゴ ASCII art が ▓ / □ に化ける問題を fix。旧 default 値を
  // そのまま使っているユーザーだけ新 default に置き換え、ユーザーが UI 等で
  // 明示的に変えていた場合は尊重する。
  if (version < 4) {
    const OLD_TERMINAL_FONT_DEFAULT_V3 =
      "'JetBrains Mono Variable', 'Geist Mono Variable', 'Cascadia Code', 'Consolas', monospace";
    if (data.terminalFontFamily === OLD_TERMINAL_FONT_DEFAULT_V3) {
      data.terminalFontFamily = DEFAULT_SETTINGS.terminalFontFamily;
    }
  }

  data.schemaVersion = APP_SETTINGS_SCHEMA_VERSION;
  // 最終マージで欠損フィールドを DEFAULT_SETTINGS で埋める
  return { ...DEFAULT_SETTINGS, ...data } as AppSettings;
}

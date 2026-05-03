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
  type AgentConfig,
  type AppSettings,
  type Language,
  type StatusMascotVariant,
  type ThemeName
} from '../../../types/shared';
import { parseShellArgsStrict } from './parse-args';

type Raw = Record<string, unknown>;

function isObject(v: unknown): v is Raw {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Issue #449: 引数文字列をパースして再構築することで、各 token 先頭の Unicode dash を
 * ASCII '-' に正規化する。空白を含む値は再構築時に `"..."` で囲み直す。
 *
 * 注意: 既に ASCII hyphen のみの入力では parseShellArgs が冪等に文字列を返す保証は無く、
 * 引用符の扱いが微妙に変わるため、Unicode dash を含むときだけ書き換える。
 */
function normalizeArgsString(raw: string): string {
  if (!UNICODE_DASH_PROBE.test(raw)) return raw;
  const tokens = parseShellArgsStrict(raw).args;
  return tokens
    .map((token) => (/[\s"]/.test(token) ? `"${token.replace(/"/g, '\\"')}"` : token))
    .join(' ');
}

/** ASCII 比較で Unicode dash 系が含まれるかだけを高速チェックする (parse-args の正本パターンと同期) */
const UNICODE_DASH_PROBE = /[‐‑‒–—―−﹘﹣－]/;

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

  // --- Version 4 → 5: terminalFontFamily を安定優先の OS mono 既定へ ---
  // 環境依存で Canvas 内 xterm の折り返し・罫線幅が崩れるケースを避けるため、
  // 旧既定の JetBrains/Geist 優先チェーンをそのまま使っているユーザーだけ
  // Cascadia Mono / Consolas 優先に移す。手動で選んだ値は維持する。
  if (version < 5) {
    const OLD_TERMINAL_FONT_DEFAULT_V4 =
      "'JetBrains Mono Variable', 'Geist Mono Variable', 'Cascadia Mono', 'Cascadia Code', Consolas, 'Lucida Console', 'Segoe UI Symbol', monospace";
    if (data.terminalFontFamily === OLD_TERMINAL_FONT_DEFAULT_V4) {
      data.terminalFontFamily = DEFAULT_SETTINGS.terminalFontFamily;
    }
  }

  // --- Version 5 → 6: ファイルツリー展開状態の永続化 (Issue #250) ---
  if (version < 6) {
    if (!isObject(data.fileTreeExpanded)) {
      data.fileTreeExpanded = {};
    } else {
      const sanitized: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(data.fileTreeExpanded as Raw)) {
        if (
          typeof k === 'string' &&
          Array.isArray(v) &&
          v.every((x) => typeof x === 'string')
        ) {
          sanitized[k] = v as string[];
        }
      }
      data.fileTreeExpanded = sanitized;
    }
    if (!Array.isArray(data.fileTreeCollapsedRoots)) {
      data.fileTreeCollapsedRoots = [];
    } else {
      data.fileTreeCollapsedRoots = (data.fileTreeCollapsedRoots as unknown[]).filter(
        (x): x is string => typeof x === 'string'
      );
    }
  }

  // --- Version 6 → 7: サイドバー幅の永続化 (Issue #337) ---
  if (version < 7) {
    if (typeof data.sidebarWidth !== 'number' || !Number.isFinite(data.sidebarWidth)) {
      data.sidebarWidth = DEFAULT_SETTINGS.sidebarWidth;
    } else if ((data.sidebarWidth as number) < 100 || (data.sidebarWidth as number) > 1200) {
      // 異常値 (負/巨大) は default に戻す。runtime clamp は別途 200..600 で行う。
      data.sidebarWidth = DEFAULT_SETTINGS.sidebarWidth;
    }
  }

  // --- Version 7 → 8: terminalFontFamily を JetBrainsMono Nerd Font Mono 既定へ (Issue #346) ---
  // 旧 default (Cascadia Mono 優先チェーン) のまま使っているユーザーだけ新 default に置き換え、
  // ユーザーが明示的に変えていた場合は尊重する。Nerd Font は本体に同梱済み。
  if (version < 8) {
    const OLD_TERMINAL_FONT_DEFAULT_V7 =
      "'Cascadia Mono', 'Cascadia Code', Consolas, 'Lucida Console', 'Segoe UI Symbol', monospace";
    if (data.terminalFontFamily === OLD_TERMINAL_FONT_DEFAULT_V7) {
      data.terminalFontFamily = DEFAULT_SETTINGS.terminalFontFamily;
    }
  }

  // --- Version 8 → 9: ステータスバー mascot の選択設定を追加 (Issue #422) ---
  const validMascots: StatusMascotVariant[] = ['vibe', 'spark', 'mono'];
  if (
    version < 9 ||
    !validMascots.includes(data.statusMascotVariant as StatusMascotVariant)
  ) {
    data.statusMascotVariant = DEFAULT_SETTINGS.statusMascotVariant;
  }

  // --- Version 9 → 10: claudeArgs / codexArgs / customAgents[].args の Unicode dash 正規化 (Issue #449) ---
  // U+2013 (en dash) などで保存された option (例: `–dangerously-bypass-approvals-and-sandbox`)
  // を ASCII '-' に置き換える。Codex / Claude CLI は Unicode dash を option として解釈しないため、
  // Codex worker でフラグが silent に無視され承認ダイアログが連発する原因になっていた。
  if (version < 10) {
    if (typeof data.claudeArgs === 'string') {
      data.claudeArgs = normalizeArgsString(data.claudeArgs);
    }
    if (typeof data.codexArgs === 'string') {
      data.codexArgs = normalizeArgsString(data.codexArgs);
    }
    if (Array.isArray(data.customAgents)) {
      data.customAgents = (data.customAgents as unknown[]).map((entry) => {
        if (!isObject(entry)) return entry;
        const agent = entry as unknown as AgentConfig;
        if (typeof agent.args === 'string') {
          return { ...agent, args: normalizeArgsString(agent.args) };
        }
        return agent;
      });
    }
  }

  data.schemaVersion = APP_SETTINGS_SCHEMA_VERSION;
  // 最終マージで欠損フィールドを DEFAULT_SETTINGS で埋める
  return { ...DEFAULT_SETTINGS, ...data } as AppSettings;
}

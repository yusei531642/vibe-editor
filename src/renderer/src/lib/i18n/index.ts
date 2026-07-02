import type { Language } from '../../../../types/shared';
import { useSettings } from '../settings-context';
import type { Dict } from './types';
import { jaShell } from './ja-shell';
import { jaCanvas } from './ja-canvas';
import { jaSettings } from './ja-settings';
import { enShell } from './en-shell';
import { enCanvas } from './en-canvas';
import { enSettings } from './en-settings';

/**
 * フラットキー方式の軽量 i18n。
 * `{param}` 形式のパラメータ置換を最低限サポート。
 *
 * Issue #1032: 辞書本体は領域別サブ辞書 (shell / canvas / settings) に分割した。
 * キーは全サブ辞書を通して一意 (重複キーは後勝ち merge で沈黙するため作らない)。
 * 新しいキーは領域の合うサブ辞書ファイルへ追加する。
 */
const ja: Dict = { ...jaShell, ...jaCanvas, ...jaSettings };
const en: Dict = { ...enShell, ...enCanvas, ...enSettings };

const translations: Record<Language, Dict> = { ja, en };

/**
 * React フック: 現在の言語設定に基づいた翻訳関数を返す。
 *
 * ```
 * const t = useT();
 * t('sidebar.changes');                    // "変更" or "Changes"
 * t('sidebar.filesChanged', { count: 3 }); // "3 変更" or "3 changed"
 * ```
 */
export function useT(): (key: string, params?: Record<string, string | number>) => string {
  const { settings } = useSettings();
  const lang = settings.language ?? 'ja';
  return (key: string, params?: Record<string, string | number>): string => {
    const text = translations[lang]?.[key] ?? translations.ja[key] ?? key;
    if (!params) return text;
    return interpolate(text, params);
  };
}

/**
 * Issue #176: String.prototype.replace の第 2 引数は `$&` `$1` `$$` 等を
 * 特殊置換シーケンスとして解釈する。Windows パスや正規表現サンプル等を
 * params に渡すと結果が壊れていた。`replace(re, fn)` の関数フォームなら
 * 戻り値は literal として扱われるので安全。
 */
function interpolate(text: string, params: Record<string, string | number>): string {
  return Object.entries(params).reduce(
    (acc, [k, v]) =>
      acc.replace(new RegExp(`\\{${k}\\}`, 'g'), () => String(v)),
    text
  );
}

/**
 * React コンテキスト外 (updater-check / timer callback など) から呼べる翻訳関数。
 * 言語を明示的に受け取るので、呼び出し元が settings.language を取って渡す必要がある。
 */
export function translate(
  lang: Language,
  key: string,
  params?: Record<string, string | number>
): string {
  const text = translations[lang]?.[key] ?? translations.ja[key] ?? key;
  if (!params) return text;
  // Issue #176: replace の関数フォームを使って `$` 特殊シーケンスを literal 化
  return Object.entries(params).reduce(
    (acc, [k, v]) =>
      acc.replace(new RegExp(`\\{${k}\\}`, 'g'), () => String(v)),
    text
  );
}

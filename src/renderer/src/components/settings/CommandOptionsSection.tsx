import type { AppSettings } from '../../../../types/shared';
import { useT } from '../../lib/i18n';
import { parseShellArgsStrict } from '../../lib/parse-args';
import type { StringSettingKey, UpdateSetting } from './types';

interface Props {
  title: string;
  commandKey: StringSettingKey;
  commandPlaceholder: string;
  argsKey: StringSettingKey;
  argsLabel: string;
  argsPlaceholder: string;
  cwdKey?: StringSettingKey;
  cwdLabel?: string;
  cwdPlaceholder?: string;
  note?: string;
  draft: AppSettings;
  update: UpdateSetting;
}

/**
 * Claude Code / Codex の起動オプションを共通化した汎用セクション。
 * cwd 欄とフッタの説明は任意で、Codex 側では省略する。
 */
export function CommandOptionsSection({
  title,
  commandKey,
  commandPlaceholder,
  argsKey,
  argsLabel,
  argsPlaceholder,
  cwdKey,
  cwdLabel,
  cwdPlaceholder,
  note,
  draft,
  update
}: Props): JSX.Element {
  const t = useT();
  // Issue #76: 閉じクォート忘れを検出してユーザーに警告する
  // Issue #449: 先頭が Unicode dash (U+2013 等) の token も警告する
  const argsParse = parseShellArgsStrict(draft[argsKey] as string);
  const hasParseWarning = argsParse.unterminatedQuote || argsParse.hasUnicodeDash;
  return (
    <section className="modal__section">
      <h3>{title}</h3>
      <label className="modal__label modal__label--full">
        <span>{t('settings.command')}</span>
        <input
          type="text"
          value={draft[commandKey]}
          onChange={(e) => update(commandKey, e.target.value)}
          placeholder={commandPlaceholder}
          spellCheck={false}
        />
      </label>
      <label className="modal__label modal__label--full">
        <span>{argsLabel}</span>
        <input
          type="text"
          value={draft[argsKey]}
          onChange={(e) => update(argsKey, e.target.value)}
          placeholder={argsPlaceholder}
          spellCheck={false}
          aria-invalid={hasParseWarning}
        />
        {argsParse.unterminatedQuote && (
          <span className="modal__error">{t('settings.argsUnterminatedQuote')}</span>
        )}
        {argsParse.hasUnicodeDash && (
          <span className="modal__error">{t('settings.argsUnicodeDash')}</span>
        )}
      </label>
      {cwdKey && (
        <label className="modal__label modal__label--full">
          <span>{cwdLabel}</span>
          <input
            type="text"
            value={draft[cwdKey]}
            onChange={(e) => update(cwdKey, e.target.value)}
            placeholder={cwdPlaceholder}
            spellCheck={false}
          />
        </label>
      )}
      {note && <p className="modal__note">{note}</p>}
    </section>
  );
}

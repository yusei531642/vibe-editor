import type { AppSettings } from '../../../../types/shared';
import { useT } from '../../lib/i18n';
import { TERMINAL_FONT_PRESETS } from '../../lib/settings-options';
import type { UpdateSetting } from './types';

interface Props {
  draft: AppSettings;
  update: UpdateSetting;
}

const IS_WINDOWS = /Win/i.test(
  (typeof navigator !== 'undefined' && (navigator.platform || navigator.userAgent)) || ''
);

export function TerminalSection({ draft, update }: Props): JSX.Element {
  const t = useT();
  const currentFamily = draft.terminalFontFamily || draft.editorFontFamily;
  const forceUtf8 = draft.terminalForceUtf8 !== false;
  return (
    <section className="modal__section">
      <h3>{t('settings.terminal')}</h3>
      <div className="modal__row">
        <label className="modal__label">
          <span>{t('settings.terminalFontFamily')}</span>
          <select
            value={currentFamily}
            onChange={(e) => {
              // Issue #165: 空文字選択で xterm が既定 monospace にフォールバックする事故を防ぐ。
              const v = e.target.value;
              if (v.trim() === '') return;
              update('terminalFontFamily', v);
            }}
            style={{ fontFamily: currentFamily }}
          >
            {TERMINAL_FONT_PRESETS.map((p) => (
              <option key={p.value} value={p.value} style={{ fontFamily: p.value }}>
                {p.label}
              </option>
            ))}
            {/* カスタム値 (preset 外) を追加で表示する */}
            {!TERMINAL_FONT_PRESETS.some((p) => p.value === currentFamily) && (
              <option value={currentFamily}>{currentFamily}</option>
            )}
          </select>
        </label>
        <label className="modal__label">
          <span>{t('settings.terminalFontSize')}</span>
          <input
            type="number"
            min={10}
            max={24}
            value={draft.terminalFontSize}
            onChange={(e) => update('terminalFontSize', Number(e.target.value) || 13)}
          />
        </label>
      </div>
      <p className="modal__note">{t('settings.terminalNote')}</p>
      <label className="mcp-toggle" style={IS_WINDOWS ? undefined : { opacity: 0.5 }}>
        <input
          type="checkbox"
          checked={forceUtf8}
          disabled={!IS_WINDOWS}
          onChange={(e) => update('terminalForceUtf8', e.target.checked)}
        />
        <span>{t('settings.terminalForceUtf8.label')}</span>
      </label>
      <p className="modal__note">
        {IS_WINDOWS
          ? t('settings.terminalForceUtf8.hint')
          : t('settings.terminalForceUtf8.nonWindows')}
      </p>
    </section>
  );
}

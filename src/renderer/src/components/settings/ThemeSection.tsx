import type { AppSettings } from '../../../../types/shared';
import { useT } from '../../lib/i18n';
import { THEME_OPTIONS } from '../../lib/settings-options';
import type { UpdateSetting } from './types';

interface Props {
  draft: AppSettings;
  update: UpdateSetting;
}

export function ThemeSection({ draft, update }: Props): JSX.Element {
  const t = useT();
  return (
    <section className="modal__section">
      <h3>{t('settings.theme')}</h3>
      <div className="modal__theme-grid">
        {THEME_OPTIONS.map((opt) => (
          <label
            key={opt.value}
            className={`theme-card ${draft.theme === opt.value ? 'is-selected' : ''}`}
          >
            <input
              type="radio"
              name="theme"
              value={opt.value}
              checked={draft.theme === opt.value}
              onChange={() => update('theme', opt.value)}
            />
            <div className={`theme-card__preview theme-preview--${opt.value}`}>
              <div className="theme-preview__sidebar" />
              <div className="theme-preview__main">
                <div className="theme-preview__bar" />
                <div className="theme-preview__content" />
              </div>
            </div>
            <div className="theme-card__meta">
              <strong>{t(`theme.label.${opt.value}`)}</strong>
              <span>{t(`theme.desc.${opt.value}`)}</span>
            </div>
          </label>
        ))}
      </div>
    </section>
  );
}

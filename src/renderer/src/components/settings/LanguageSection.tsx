import type { AppSettings, Language } from '../../../../types/shared';
import { useT } from '../../lib/i18n';
import type { UpdateSetting } from './types';

interface Props {
  draft: AppSettings;
  update: UpdateSetting;
}

const LANGUAGES: ReadonlyArray<Language> = ['ja', 'en'];

export function LanguageSection({ draft, update }: Props): JSX.Element {
  const t = useT();
  return (
    <section className="modal__section">
      <h3>{t('settings.language')}</h3>
      <div className="lang-grid">
        {LANGUAGES.map((lang) => (
          <label
            key={lang}
            className={`lang-card ${draft.language === lang ? 'is-selected' : ''}`}
          >
            <input
              type="radio"
              name="language"
              value={lang}
              checked={draft.language === lang}
              onChange={() => update('language', lang)}
            />
            <strong>{t(`lang.label.${lang}`)}</strong>
            <span>{t(`lang.label.${lang}.sub`)}</span>
          </label>
        ))}
      </div>
      <p className="modal__note">{t('settings.language.desc')}</p>
    </section>
  );
}

import type { AppSettings, Language } from '../../../../types/shared';
import { useT } from '../../lib/i18n';
import type { UpdateSetting } from './types';

interface Props {
  draft: AppSettings;
  update: UpdateSetting;
}

export function LanguageSection({ draft, update }: Props): JSX.Element {
  const t = useT();
  return (
    <section className="modal__section">
      <h3>{t('settings.language')}</h3>
      <div className="lang-grid">
        {(['ja', 'en'] as Language[]).map((lang) => (
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
            <strong>{lang === 'ja' ? '日本語' : 'English'}</strong>
            <span>{lang === 'ja' ? 'Japanese' : 'English'}</span>
          </label>
        ))}
      </div>
      <p className="modal__note">{t('settings.language.desc')}</p>
    </section>
  );
}

import type { AppSettings } from '../../../../types/shared';
import { useT } from '../../lib/i18n';
import { DENSITY_OPTIONS } from '../../lib/settings-options';
import type { UpdateSetting } from './types';

interface Props {
  draft: AppSettings;
  update: UpdateSetting;
}

export function DensitySection({ draft, update }: Props): JSX.Element {
  const t = useT();
  return (
    <section className="modal__section">
      <h3>{t('settings.density')}</h3>
      <div className="density-grid">
        {DENSITY_OPTIONS.map((opt) => (
          <label
            key={opt.value}
            className={`density-card ${draft.density === opt.value ? 'is-selected' : ''}`}
          >
            <input
              type="radio"
              name="density"
              value={opt.value}
              checked={draft.density === opt.value}
              onChange={() => update('density', opt.value)}
            />
            <strong>{opt.label}</strong>
            <span>{t(`density.desc.${opt.value}`)}</span>
          </label>
        ))}
      </div>
    </section>
  );
}

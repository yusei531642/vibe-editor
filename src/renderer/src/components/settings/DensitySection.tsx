import type { AppSettings } from '../../../../types/shared';
import { DENSITY_OPTIONS } from '../../lib/settings-options';
import type { UpdateSetting } from './types';

interface Props {
  draft: AppSettings;
  update: UpdateSetting;
}

export function DensitySection({ draft, update }: Props): JSX.Element {
  return (
    <section className="modal__section">
      <h3>情報密度</h3>
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
            <span>{opt.desc}</span>
          </label>
        ))}
      </div>
    </section>
  );
}

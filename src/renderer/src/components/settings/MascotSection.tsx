import { DEFAULT_SETTINGS, type AppSettings } from '../../../../types/shared';
import { STATUS_MASCOT_OPTIONS } from '../../lib/settings-options';
import { StatusMascot } from '../shell/StatusMascot';
import type { UpdateSetting } from './types';

interface Props {
  draft: AppSettings;
  update: UpdateSetting;
}

export function MascotSection({ draft, update }: Props): JSX.Element {
  const isJa = draft.language === 'ja';
  const selected = draft.statusMascotVariant ?? DEFAULT_SETTINGS.statusMascotVariant;

  return (
    <section className="modal__section">
      <h3>{isJa ? 'キャラクター' : 'Character'}</h3>
      <div className="mascot-grid">
        {STATUS_MASCOT_OPTIONS.map((opt) => (
          <label
            key={opt.value}
            className={`mascot-card ${selected === opt.value ? 'is-selected' : ''}`}
          >
            <input
              type="radio"
              name="statusMascotVariant"
              value={opt.value}
              checked={selected === opt.value}
              onChange={() => update('statusMascotVariant', opt.value)}
            />
            <span className="mascot-card__preview" aria-hidden="true">
              <StatusMascot state="idle" label={opt.label} variant={opt.value} />
            </span>
            <span className="mascot-card__meta">
              <strong>{opt.label}</strong>
              <span>{isJa ? opt.descJa : opt.descEn}</span>
            </span>
          </label>
        ))}
      </div>
    </section>
  );
}

import { DEFAULT_SETTINGS, type AppSettings } from '../../../../types/shared';
import { useT } from '../../lib/i18n';
import { STATUS_MASCOT_OPTIONS } from '../../lib/settings-options';
import { StatusMascot } from '../shell/StatusMascot';
import type { UpdateSetting } from './types';

interface Props {
  draft: AppSettings;
  update: UpdateSetting;
}

export function MascotSection({ draft, update }: Props): JSX.Element {
  const t = useT();
  const selected = draft.statusMascotVariant ?? DEFAULT_SETTINGS.statusMascotVariant;
  const customPath = draft.statusMascotCustomPath ?? '';

  const pickCustomImage = async (): Promise<void> => {
    // Issue #1193: native pickerの選択結果をRust側private storeへコピーする。同じpathを
    // settingsに保存しても、それは表示用でありasset/fs authorityには使わない。
    const picked = await window.api.settings.pickCustomMascot(t('settings.mascot.pickTitle'));
    if (!picked) return;
    update('statusMascotCustomPath', picked);
    if (selected !== 'custom') update('statusMascotVariant', 'custom');
  };

  const clearCustomImage = (): void => {
    update('statusMascotCustomPath', '');
    update('statusMascotVariant', DEFAULT_SETTINGS.statusMascotVariant);
    void window.api.settings.clearCustomMascot().catch((error) => {
      console.warn('[mascot] private image cleanup failed:', error);
    });
  };

  return (
    <section className="modal__section">
      <h3>{t('settings.mascot.title')}</h3>
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
              <StatusMascot
                state="idle"
                label={opt.label}
                variant={opt.value}
                customPath={opt.value === 'custom' ? customPath : undefined}
              />
            </span>
            <span className="mascot-card__meta">
              <strong>{opt.label}</strong>
              <span>{t(`mascot.desc.${opt.value}`)}</span>
            </span>
          </label>
        ))}
      </div>

      {selected === 'custom' && (
        <div className="mascot-custom">
          <div className="mascot-custom__row">
            <button
              type="button"
              className="mascot-custom__pick"
              onClick={() => void pickCustomImage()}
            >
              {t('settings.mascot.choose')}
            </button>
            {customPath ? (
              <button
                type="button"
                className="mascot-custom__clear"
                onClick={clearCustomImage}
              >
                {t('settings.mascot.clear')}
              </button>
            ) : null}
          </div>
          {customPath ? (
            <p className="mascot-custom__path" title={customPath}>
              {customPath}
            </p>
          ) : (
            <p className="mascot-custom__hint">{t('settings.mascot.hint')}</p>
          )}
        </div>
      )}
    </section>
  );
}

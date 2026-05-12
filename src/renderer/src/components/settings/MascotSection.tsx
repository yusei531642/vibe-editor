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
  const customPath = draft.statusMascotCustomPath ?? '';

  const pickCustomImage = async (): Promise<void> => {
    const title = isJa ? '相棒にする画像を選択' : 'Pick a mascot image';
    const picked = await window.api.dialog.openFile(title);
    if (!picked) return;
    update('statusMascotCustomPath', picked);
    if (selected !== 'custom') update('statusMascotVariant', 'custom');
  };

  const clearCustomImage = (): void => {
    update('statusMascotCustomPath', '');
  };

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
              <StatusMascot
                state="idle"
                label={opt.label}
                variant={opt.value}
                customPath={opt.value === 'custom' ? customPath : undefined}
              />
            </span>
            <span className="mascot-card__meta">
              <strong>{opt.label}</strong>
              <span>{isJa ? opt.descJa : opt.descEn}</span>
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
              {isJa ? '画像を選ぶ…' : 'Choose image…'}
            </button>
            {customPath ? (
              <button
                type="button"
                className="mascot-custom__clear"
                onClick={clearCustomImage}
              >
                {isJa ? 'クリア' : 'Clear'}
              </button>
            ) : null}
          </div>
          {customPath ? (
            <p className="mascot-custom__path" title={customPath}>
              {customPath}
            </p>
          ) : (
            <p className="mascot-custom__hint">
              {isJa
                ? 'PNG / GIF (アニメ可) / APNG / WebP / SVG を選べます。\n小さめ (32〜128px) の正方形が綺麗に出ます。'
                : 'PNG / GIF (animated) / APNG / WebP / SVG. A small square (32–128 px) renders best.'}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

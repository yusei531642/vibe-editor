import { X } from 'lucide-react';
import type { Density, Language, ThemeName } from '../../../../types/shared';
import { useT } from '../../lib/i18n';
import { useSettings } from '../../lib/settings-context';
import { useUiStore } from '../../stores/ui';

const THEME_IDS: ReadonlyArray<ThemeName> = [
  'claude-dark',
  'claude-light',
  'dark',
  'light',
  'midnight',
  'glass'
];

const DENSITY_IDS: ReadonlyArray<Density> = ['compact', 'normal', 'comfortable'];

const LANGUAGE_IDS: ReadonlyArray<Language> = ['ja', 'en'];

/**
 * TweaksPanel — 右下に浮かぶクイック調整パネル。
 * Claude Design バンドルの .tweaks を移植し、既存 `useSettings` に値を書き戻す。
 * テーマ / 密度 / 言語の 3 項目に絞り、詳細は SettingsModal に委譲する。
 */
export function TweaksPanel(): JSX.Element | null {
  const t = useT();
  const { settings, update } = useSettings();
  const open = useUiStore((s) => s.tweaksOpen);
  const setOpen = useUiStore((s) => s.setTweaksOpen);

  if (!open) return null;

  return (
    <div className="tweaks is-open" role="dialog" aria-label={t('tweaks.title')}>
      <div className="tweaks__head">
        <span>{t('tweaks.title')}</span>
        <button
          type="button"
          className="tweaks__close"
          onClick={() => setOpen(false)}
          aria-label={t('tweaks.close')}
        >
          <X size={14} strokeWidth={2} />
        </button>
      </div>
      <div className="tweaks__body">
        <div className="tw-group">
          <div className="tw-label">{t('tweaks.theme')}</div>
          <div className="tw-row">
            {THEME_IDS.map((id) => (
              <button
                key={id}
                type="button"
                className={`tw-chip${settings.theme === id ? ' is-active' : ''}`}
                onClick={() => void update({ theme: id })}
              >
                {t(`theme.label.${id}`)}
              </button>
            ))}
          </div>
        </div>
        <div className="tw-group">
          <div className="tw-label">{t('tweaks.density')}</div>
          <div className="tw-row">
            {DENSITY_IDS.map((id) => (
              <button
                key={id}
                type="button"
                className={`tw-chip${settings.density === id ? ' is-active' : ''}`}
                onClick={() => void update({ density: id })}
              >
                {t(`settings.density.${id}`)}
              </button>
            ))}
          </div>
        </div>
        <div className="tw-group">
          <div className="tw-label">{t('tweaks.language')}</div>
          <div className="tw-row">
            {LANGUAGE_IDS.map((id) => (
              <button
                key={id}
                type="button"
                className={`tw-chip${settings.language === id ? ' is-active' : ''}`}
                onClick={() => void update({ language: id })}
              >
                {t(`lang.label.${id}`)}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

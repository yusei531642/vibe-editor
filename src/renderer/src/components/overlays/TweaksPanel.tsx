import { X } from 'lucide-react';
import type { Density, Language, ThemeName } from '../../../../types/shared';
import { useT } from '../../lib/i18n';
import { useSettings } from '../../lib/settings-context';
import { useUiStore } from '../../stores/ui';

const THEMES: ReadonlyArray<{ id: ThemeName; label: string }> = [
  { id: 'claude-dark', label: 'claude dark' },
  { id: 'claude-light', label: 'claude light' },
  { id: 'dark', label: 'dark' },
  { id: 'light', label: 'light' },
  { id: 'midnight', label: 'midnight' },
  { id: 'glass', label: 'glass' }
];

const DENSITIES: ReadonlyArray<{ id: Density; label: string }> = [
  { id: 'compact', label: 'compact' },
  { id: 'normal', label: 'normal' },
  { id: 'comfortable', label: 'comfortable' }
];

const LANGUAGES: ReadonlyArray<{ id: Language; label: string }> = [
  { id: 'ja', label: '日本語' },
  { id: 'en', label: 'English' }
];

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
            {THEMES.map((theme) => (
              <button
                key={theme.id}
                type="button"
                className={`tw-chip${settings.theme === theme.id ? ' is-active' : ''}`}
                onClick={() => void update({ theme: theme.id })}
              >
                {theme.label}
              </button>
            ))}
          </div>
        </div>
        <div className="tw-group">
          <div className="tw-label">{t('tweaks.density')}</div>
          <div className="tw-row">
            {DENSITIES.map((d) => (
              <button
                key={d.id}
                type="button"
                className={`tw-chip${settings.density === d.id ? ' is-active' : ''}`}
                onClick={() => void update({ density: d.id })}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>
        <div className="tw-group">
          <div className="tw-label">{t('tweaks.language')}</div>
          <div className="tw-row">
            {LANGUAGES.map((lng) => (
              <button
                key={lng.id}
                type="button"
                className={`tw-chip${settings.language === lng.id ? ' is-active' : ''}`}
                onClick={() => void update({ language: lng.id })}
              >
                {lng.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

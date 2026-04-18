import { Pencil, Trash2 } from 'lucide-react';
import type { TeamPreset } from '../../../../types/shared';
import { useT } from '../../lib/i18n';
import { BUILTIN_PRESETS, canSpawnPreset, type BuiltinPreset } from '../../lib/team-presets';

interface Props {
  savedPresets: TeamPreset[];
  remaining: number;
  editingPresetId: string | null;
  onPickBuiltin: (preset: BuiltinPreset) => void;
  onPickSaved: (preset: TeamPreset) => void;
  onEditSaved: (preset: TeamPreset) => void;
  onDeleteSaved: (id: string) => void;
}

export function TeamPresetList({
  savedPresets,
  remaining,
  editingPresetId,
  onPickBuiltin,
  onPickSaved,
  onEditSaved,
  onDeleteSaved
}: Props): JSX.Element {
  const t = useT();
  return (
    <section className="modal__section">
      <h3>{t('team.presets')}</h3>
      <div className="team-presets">
        {BUILTIN_PRESETS.map((p) => {
          const needed = 1 + p.members.length;
          const spawnable = canSpawnPreset(needed, remaining);
          return (
            <button
              key={p.name}
              type="button"
              className="team-preset-card"
              onClick={() => onPickBuiltin(p)}
              disabled={!spawnable}
              title={
                !spawnable
                  ? t('team.tooMany', { need: needed, remaining })
                  : undefined
              }
            >
              <strong>{p.name}</strong>
              <span className="team-preset-card__members">
                Leader + {p.members.map((m) => m.role).join(' + ')}
              </span>
              <span className="team-preset-card__count">
                {needed} {t('team.members')}
              </span>
            </button>
          );
        })}
        {savedPresets.map((p) => (
          <div
            key={p.id}
            className="team-preset-card team-preset-card--saved"
            data-editing={editingPresetId === p.id ? '' : undefined}
          >
            <button
              type="button"
              className="team-preset-card__main"
              onClick={() => onPickSaved(p)}
              disabled={!canSpawnPreset(p.members.length, remaining)}
            >
              <strong>{p.name}</strong>
              <span className="team-preset-card__members">
                {p.members.map((m) => m.role).join(' + ')}
              </span>
              <span className="team-preset-card__count">
                {p.members.length} {t('team.members')}
              </span>
            </button>
            <button
              type="button"
              className="team-preset-card__edit"
              onClick={() => onEditSaved(p)}
              title={t('team.editPreset')}
              aria-label={t('team.editPreset')}
            >
              <Pencil size={12} />
            </button>
            <button
              type="button"
              className="team-preset-card__delete"
              onClick={() => onDeleteSaved(p.id)}
              title={t('team.deletePreset')}
              aria-label={t('team.deletePreset')}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

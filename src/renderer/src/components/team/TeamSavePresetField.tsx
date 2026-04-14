import { useT } from '../../lib/i18n';

interface Props {
  saveAsPreset: boolean;
  presetName: string;
  teamName: string;
  editingPresetId: string | null;
  onToggleSave: (checked: boolean) => void;
  onChangePresetName: (name: string) => void;
}

export function TeamSavePresetField({
  saveAsPreset,
  presetName,
  teamName,
  editingPresetId,
  onToggleSave,
  onChangePresetName
}: Props): JSX.Element {
  const t = useT();
  return (
    <section className="modal__section">
      <label className="team-save-check">
        <input
          type="checkbox"
          checked={saveAsPreset}
          onChange={(e) => onToggleSave(e.target.checked)}
        />
        <span>{editingPresetId ? t('team.updatePreset') : t('team.saveAsPreset')}</span>
      </label>
      {saveAsPreset && (
        <input
          className="team-save-name"
          type="text"
          value={presetName}
          onChange={(e) => onChangePresetName(e.target.value)}
          placeholder={teamName.trim() || t('team.presetName')}
          spellCheck={false}
        />
      )}
    </section>
  );
}

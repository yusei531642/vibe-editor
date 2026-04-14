import { Users, X } from 'lucide-react';
import type { Team, TeamMember, TeamPreset, TerminalAgent } from '../../../types/shared';
import { useT } from '../lib/i18n';
import { useAnimatedMount } from '../lib/use-animated-mount';
import { presetFromMembers, type BuiltinPreset } from '../lib/team-presets';
import { useTeamBuilder } from '../lib/use-team-builder';
import { TeamPresetList } from './team/TeamPresetList';
import { TeamMemberBuilder } from './team/TeamMemberBuilder';
import { TeamSavePresetField } from './team/TeamSavePresetField';

interface TeamCreateModalProps {
  open: boolean;
  onClose: () => void;
  onCreate: (
    teamName: string,
    leader: { agent: TerminalAgent },
    members: TeamMember[]
  ) => void;
  savedPresets: TeamPreset[];
  onSavePreset: (preset: TeamPreset) => void;
  onDeletePreset: (id: string) => void;
  maxTerminals: number;
  currentTabCount: number;
  existingTeams: Team[];
}

export function TeamCreateModal({
  open,
  onClose,
  onCreate,
  savedPresets,
  onSavePreset,
  onDeletePreset,
  maxTerminals,
  currentTabCount
}: TeamCreateModalProps): JSX.Element | null {
  const t = useT();
  const { mounted, state } = useAnimatedMount(open, 260);
  const { form, actions, totalNeeded } = useTeamBuilder();

  if (!mounted) return null;

  const remaining = maxTerminals - currentTabCount;

  const handleSaveEditedPreset = (): void => {
    if (!form.presetName.trim()) return;
    onSavePreset({
      id: form.editingPresetId ?? `custom-${Date.now()}`,
      name: form.presetName.trim(),
      members: presetFromMembers(form.leaderAgent, form.members)
    });
    actions.setEditingPresetId(null);
    actions.setSaveAsPreset(false);
    actions.setPresetName('');
  };

  const handleCreate = (): void => {
    const name = form.teamName.trim() || 'Team';
    if (form.saveAsPreset) {
      const pname = form.presetName.trim() || name;
      onSavePreset({
        id: form.editingPresetId ?? `custom-${Date.now()}`,
        name: pname,
        members: presetFromMembers(form.leaderAgent, form.members)
      });
    }
    actions.resetAfterCreate();
    onCreate(name, { agent: form.leaderAgent }, form.members);
    onClose();
  };

  const handlePickBuiltin = (preset: BuiltinPreset): void => {
    const needed = 1 + preset.members.length;
    if (needed > remaining) return;
    onCreate(preset.name, { agent: preset.leaderAgent }, preset.members);
    onClose();
  };

  const handlePickSaved = (preset: TeamPreset): void => {
    const leader = preset.members.find((m) => m.role === 'leader');
    const others = preset.members.filter((m) => m.role !== 'leader');
    if (preset.members.length > remaining) return;
    onCreate(preset.name, { agent: leader?.agent ?? 'claude' }, others);
    onClose();
  };

  const handleToggleSave = (checked: boolean): void => {
    actions.setSaveAsPreset(checked);
    if (!checked) actions.setEditingPresetId(null);
  };

  return (
    <div className="modal-backdrop" data-state={state} onClick={onClose}>
      <div
        className="modal team-modal"
        data-state={state}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal__header">
          <h2>
            <Users size={18} strokeWidth={2} style={{ marginRight: 8, verticalAlign: -3 }} />
            {t('team.title')}
          </h2>
          <button type="button" className="modal__close" onClick={onClose} aria-label="Close">
            <X size={18} strokeWidth={2} />
          </button>
        </header>

        <div className="modal__body">
          <TeamPresetList
            savedPresets={savedPresets}
            remaining={remaining}
            editingPresetId={form.editingPresetId}
            onPickBuiltin={handlePickBuiltin}
            onPickSaved={handlePickSaved}
            onEditSaved={actions.loadPresetForEdit}
            onDeleteSaved={onDeletePreset}
          />
          <TeamMemberBuilder
            form={form}
            actions={actions}
            totalNeeded={totalNeeded}
            remaining={remaining}
          />
          <TeamSavePresetField
            saveAsPreset={form.saveAsPreset}
            presetName={form.presetName}
            teamName={form.teamName}
            editingPresetId={form.editingPresetId}
            onToggleSave={handleToggleSave}
            onChangePresetName={actions.setPresetName}
          />
        </div>

        <footer className="modal__footer">
          <div>
            {form.editingPresetId && (
              <button type="button" className="toolbar__btn" onClick={actions.cancelEdit}>
                {t('team.cancelEdit')}
              </button>
            )}
          </div>
          <div className="modal__footer-right">
            {form.editingPresetId && (
              <button
                type="button"
                className="toolbar__btn toolbar__btn--primary"
                onClick={handleSaveEditedPreset}
                disabled={!form.presetName.trim()}
              >
                {t('team.savePreset')}
              </button>
            )}
            <button type="button" className="toolbar__btn" onClick={onClose}>
              {t('settings.cancel')}
            </button>
            <button
              type="button"
              className="toolbar__btn toolbar__btn--primary"
              onClick={handleCreate}
              disabled={totalNeeded > remaining}
            >
              {t('team.create')} ({totalNeeded})
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { Plus, Trash2, Users, X } from 'lucide-react';
import type { TeamMember, TeamPreset, TeamRole, TerminalAgent } from '../../../types/shared';
import { useT } from '../lib/i18n';
import { useAnimatedMount } from '../lib/use-animated-mount';

const AGENTS: { value: TerminalAgent; label: string }[] = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' }
];

const ROLES: { value: TeamRole; label: string; labelEn: string }[] = [
  { value: 'planner', label: 'Planner', labelEn: 'Planner' },
  { value: 'programmer', label: 'Programmer', labelEn: 'Programmer' },
  { value: 'researcher', label: 'Researcher', labelEn: 'Researcher' },
  { value: 'reviewer', label: 'Reviewer', labelEn: 'Reviewer' }
];

const BUILTIN_PRESETS: { name: string; nameEn: string; members: TeamMember[] }[] = [
  {
    name: 'Dev Duo',
    nameEn: 'Dev Duo',
    members: [
      { agent: 'claude', role: 'planner' },
      { agent: 'claude', role: 'programmer' }
    ]
  },
  {
    name: 'Full Team',
    nameEn: 'Full Team',
    members: [
      { agent: 'claude', role: 'planner' },
      { agent: 'claude', role: 'programmer' },
      { agent: 'claude', role: 'researcher' },
      { agent: 'claude', role: 'reviewer' }
    ]
  },
  {
    name: 'Mixed Team',
    nameEn: 'Mixed Team',
    members: [
      { agent: 'claude', role: 'planner' },
      { agent: 'claude', role: 'programmer' },
      { agent: 'codex', role: 'researcher' }
    ]
  }
];

interface TeamCreateModalProps {
  open: boolean;
  onClose: () => void;
  onCreate: (members: TeamMember[]) => void;
  savedPresets: TeamPreset[];
  onSavePreset: (preset: TeamPreset) => void;
  onDeletePreset: (id: string) => void;
  maxTerminals: number;
  currentTabCount: number;
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

  const [members, setMembers] = useState<TeamMember[]>([
    { agent: 'claude', role: 'planner' },
    { agent: 'claude', role: 'programmer' }
  ]);
  const [saveAsPreset, setSaveAsPreset] = useState(false);
  const [presetName, setPresetName] = useState('');

  if (!mounted) return null;

  const remaining = maxTerminals - currentTabCount;

  const addMember = (): void => {
    if (members.length >= remaining) return;
    setMembers((prev) => [...prev, { agent: 'claude', role: 'programmer' }]);
  };

  const removeMember = (idx: number): void => {
    if (members.length <= 1) return;
    setMembers((prev) => prev.filter((_, i) => i !== idx));
  };

  const updateMember = (idx: number, field: keyof TeamMember, value: string): void => {
    setMembers((prev) =>
      prev.map((m, i) => (i === idx ? { ...m, [field]: value } : m))
    );
  };

  const handleCreate = (): void => {
    if (saveAsPreset && presetName.trim()) {
      onSavePreset({
        id: `custom-${Date.now()}`,
        name: presetName.trim(),
        members: [...members]
      });
    }
    onCreate(members);
    onClose();
  };

  const handlePresetCreate = (presetMembers: TeamMember[]): void => {
    if (presetMembers.length > remaining) return;
    onCreate(presetMembers);
    onClose();
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
          {/* プリセット */}
          <section className="modal__section">
            <h3>{t('team.presets')}</h3>
            <div className="team-presets">
              {BUILTIN_PRESETS.map((p) => (
                <button
                  key={p.name}
                  className="team-preset-card"
                  onClick={() => handlePresetCreate(p.members)}
                  disabled={p.members.length > remaining}
                  title={
                    p.members.length > remaining
                      ? t('team.tooMany', { need: p.members.length, remaining })
                      : undefined
                  }
                >
                  <strong>{p.name}</strong>
                  <span className="team-preset-card__members">
                    {p.members.map((m) => `${m.role}`).join(' + ')}
                  </span>
                  <span className="team-preset-card__count">
                    {p.members.length} {t('team.members')}
                  </span>
                </button>
              ))}
              {savedPresets.map((p) => (
                <div key={p.id} className="team-preset-card team-preset-card--saved">
                  <button
                    className="team-preset-card__main"
                    onClick={() => handlePresetCreate(p.members)}
                    disabled={p.members.length > remaining}
                  >
                    <strong>{p.name}</strong>
                    <span className="team-preset-card__members">
                      {p.members.map((m) => `${m.role}`).join(' + ')}
                    </span>
                    <span className="team-preset-card__count">
                      {p.members.length} {t('team.members')}
                    </span>
                  </button>
                  <button
                    className="team-preset-card__delete"
                    onClick={() => onDeletePreset(p.id)}
                    title={t('team.deletePreset')}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          </section>

          {/* カスタムチーム */}
          <section className="modal__section">
            <h3>{t('team.custom')}</h3>
            <div className="team-builder">
              {members.map((m, idx) => (
                <div key={idx} className="team-builder__row">
                  <select
                    value={m.agent}
                    onChange={(e) => updateMember(idx, 'agent', e.target.value)}
                  >
                    {AGENTS.map((a) => (
                      <option key={a.value} value={a.value}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                  <select
                    value={m.role}
                    onChange={(e) => updateMember(idx, 'role', e.target.value)}
                  >
                    {ROLES.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                  <button
                    className="team-builder__remove"
                    onClick={() => removeMember(idx)}
                    disabled={members.length <= 1}
                    title={t('team.removeMember')}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
              <button
                className="team-builder__add"
                onClick={addMember}
                disabled={members.length >= remaining}
              >
                <Plus size={14} />
                {t('team.addMember')}
              </button>
            </div>
            <p className="modal__note">
              {t('team.remaining', { count: remaining })}
            </p>
          </section>

          {/* プリセットとして保存 */}
          <section className="modal__section">
            <label className="team-save-check">
              <input
                type="checkbox"
                checked={saveAsPreset}
                onChange={(e) => setSaveAsPreset(e.target.checked)}
              />
              <span>{t('team.saveAsPreset')}</span>
            </label>
            {saveAsPreset && (
              <input
                className="team-save-name"
                type="text"
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                placeholder={t('team.presetName')}
                spellCheck={false}
                autoFocus
              />
            )}
          </section>
        </div>

        <footer className="modal__footer">
          <div />
          <div className="modal__footer-right">
            <button type="button" className="toolbar__btn" onClick={onClose}>
              {t('settings.cancel')}
            </button>
            <button
              type="button"
              className="toolbar__btn toolbar__btn--primary"
              onClick={handleCreate}
              disabled={members.length === 0 || members.length > remaining}
            >
              {t('team.create')} ({members.length})
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

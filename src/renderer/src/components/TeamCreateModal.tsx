import { useState } from 'react';
import { Crown, Plus, Trash2, Users, X } from 'lucide-react';
import type { Team, TeamMember, TeamPreset, TeamRole, TerminalAgent } from '../../../types/shared';
import { useT } from '../lib/i18n';
import { useAnimatedMount } from '../lib/use-animated-mount';

const AGENTS: { value: TerminalAgent; label: string }[] = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' }
];

/** Leader 以外のロール */
const MEMBER_ROLES: { value: TeamRole; label: string }[] = [
  { value: 'planner', label: 'Planner' },
  { value: 'programmer', label: 'Programmer' },
  { value: 'researcher', label: 'Researcher' },
  { value: 'reviewer', label: 'Reviewer' }
];

/** ビルトインプリセット（Leader + メンバー） */
const BUILTIN_PRESETS: {
  name: string;
  leaderAgent: TerminalAgent;
  members: TeamMember[];
}[] = [
  {
    name: 'Dev Duo',
    leaderAgent: 'claude',
    members: [{ agent: 'claude', role: 'programmer' }]
  },
  {
    name: 'Full Team',
    leaderAgent: 'claude',
    members: [
      { agent: 'claude', role: 'planner' },
      { agent: 'claude', role: 'programmer' },
      { agent: 'claude', role: 'researcher' },
      { agent: 'claude', role: 'reviewer' }
    ]
  },
  {
    name: 'Code Squad',
    leaderAgent: 'claude',
    members: [
      { agent: 'claude', role: 'planner' },
      { agent: 'claude', role: 'programmer' },
      { agent: 'claude', role: 'programmer' },
      { agent: 'codex', role: 'programmer' }
    ]
  }
];

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

  const [teamName, setTeamName] = useState('');
  const [leaderAgent, setLeaderAgent] = useState<TerminalAgent>('claude');
  const [members, setMembers] = useState<TeamMember[]>([
    { agent: 'claude', role: 'programmer' }
  ]);
  const [saveAsPreset, setSaveAsPreset] = useState(false);
  const [presetName, setPresetName] = useState('');

  if (!mounted) return null;

  const remaining = maxTerminals - currentTabCount;
  const totalNeeded = 1 + members.length; // leader + members

  const addMember = (): void => {
    if (totalNeeded >= remaining) return;
    setMembers((prev) => [...prev, { agent: 'claude', role: 'programmer' }]);
  };

  const removeMember = (idx: number): void => {
    setMembers((prev) => prev.filter((_, i) => i !== idx));
  };

  const updateMember = (idx: number, field: keyof TeamMember, value: string): void => {
    setMembers((prev) =>
      prev.map((m, i) => (i === idx ? { ...m, [field]: value } : m))
    );
  };

  const handleCreate = (): void => {
    const name = teamName.trim() || 'Team';
    if (saveAsPreset && presetName.trim()) {
      onSavePreset({
        id: `custom-${Date.now()}`,
        name: presetName.trim(),
        members: [{ agent: leaderAgent, role: 'leader' as TeamRole }, ...members]
      });
    }
    onCreate(name, { agent: leaderAgent }, members);
    onClose();
  };

  const handlePresetCreate = (
    preset: { leaderAgent: TerminalAgent; members: TeamMember[]; name: string }
  ): void => {
    const needed = 1 + preset.members.length;
    if (needed > remaining) return;
    onCreate(preset.name, { agent: preset.leaderAgent }, preset.members);
    onClose();
  };

  const handleSavedPresetCreate = (preset: TeamPreset): void => {
    const leader = preset.members.find((m) => m.role === 'leader');
    const others = preset.members.filter((m) => m.role !== 'leader');
    if (preset.members.length > remaining) return;
    onCreate(
      preset.name,
      { agent: leader?.agent ?? 'claude' },
      others
    );
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
                  onClick={() => handlePresetCreate(p)}
                  disabled={1 + p.members.length > remaining}
                  title={
                    1 + p.members.length > remaining
                      ? t('team.tooMany', { need: 1 + p.members.length, remaining })
                      : undefined
                  }
                >
                  <strong>{p.name}</strong>
                  <span className="team-preset-card__members">
                    Leader + {p.members.map((m) => m.role).join(' + ')}
                  </span>
                  <span className="team-preset-card__count">
                    {1 + p.members.length} {t('team.members')}
                  </span>
                </button>
              ))}
              {savedPresets.map((p) => (
                <div key={p.id} className="team-preset-card team-preset-card--saved">
                  <button
                    className="team-preset-card__main"
                    onClick={() => handleSavedPresetCreate(p)}
                    disabled={p.members.length > remaining}
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

            {/* チーム名 */}
            <input
              className="team-save-name"
              type="text"
              value={teamName}
              onChange={(e) => setTeamName(e.target.value)}
              placeholder={t('team.teamNamePlaceholder')}
              spellCheck={false}
              style={{ marginBottom: 10 }}
            />

            {/* Leader（常に1名、削除不可） */}
            <div className="team-builder">
              <div className="team-builder__row team-builder__row--leader">
                <Crown size={14} className="terminal-tab__leader-icon" />
                <span className="team-builder__label">Leader</span>
                <select
                  value={leaderAgent}
                  onChange={(e) => setLeaderAgent(e.target.value as TerminalAgent)}
                >
                  {AGENTS.map((a) => (
                    <option key={a.value} value={a.value}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* メンバー */}
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
                    {MEMBER_ROLES.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                  <button
                    className="team-builder__remove"
                    onClick={() => removeMember(idx)}
                    title={t('team.removeMember')}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}

              <button
                className="team-builder__add"
                onClick={addMember}
                disabled={totalNeeded >= remaining}
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

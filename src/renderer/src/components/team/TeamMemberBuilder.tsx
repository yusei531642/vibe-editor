import { Crown, Plus, X } from 'lucide-react';
import type { TerminalAgent } from '../../../../types/shared';
import { useT } from '../../lib/i18n';
import { AGENTS, MEMBER_ROLES } from '../../lib/team-presets';
import type { TeamBuilderActions, TeamBuilderForm } from '../../lib/use-team-builder';

interface Props {
  form: TeamBuilderForm;
  actions: TeamBuilderActions;
  totalNeeded: number;
  remaining: number;
}

export function TeamMemberBuilder({
  form,
  actions,
  totalNeeded,
  remaining
}: Props): JSX.Element {
  const t = useT();
  return (
    <section className="modal__section">
      <h3>{t('team.custom')}</h3>

      {/* チーム名 */}
      <input
        className="team-save-name"
        type="text"
        value={form.teamName}
        onChange={(e) => actions.setTeamName(e.target.value)}
        placeholder={t('team.teamNamePlaceholder')}
        spellCheck={false}
        style={{ marginBottom: 10 }}
      />

      {/* Leader（常に1名、削除不可） */}
      <div className="team-builder">
        <div className="team-builder__row team-builder__row--leader">
          <Crown size={14} className="terminal-tab__leader-icon" />
          {/* Issue #82: Leader ラベルも i18n 化する。 */}
          <span className="team-builder__label">{t('team.leaderLabel')}</span>
          <select
            value={form.leaderAgent}
            onChange={(e) => actions.setLeaderAgent(e.target.value as TerminalAgent)}
          >
            {AGENTS.map((a) => (
              <option key={a.value} value={a.value}>
                {t(a.labelKey)}
              </option>
            ))}
          </select>
        </div>

        {/* メンバー */}
        {/* Issue #83: key は unique _rowId を使う。idx だと削除で入力 state が別メンバーに引き継がれる。 */}
        {form.members.map((m, idx) => (
          <div key={m._rowId} className="team-builder__row">
            <select
              value={m.agent}
              onChange={(e) => actions.updateMember(idx, 'agent', e.target.value)}
            >
              {AGENTS.map((a) => (
                <option key={a.value} value={a.value}>
                  {t(a.labelKey)}
                </option>
              ))}
            </select>
            <select
              value={m.role}
              onChange={(e) => actions.updateMember(idx, 'role', e.target.value)}
            >
              {MEMBER_ROLES.map((r) => (
                <option key={r.value} value={r.value}>
                  {t(r.labelKey)}
                </option>
              ))}
            </select>
            {/* Issue #84: type="button" を明示し、将来 <form> 内に置かれても誤 submit しない。 */}
            {/* Issue #86: aria-label で削除操作の意図をスクリーンリーダーに伝える。 */}
            <button
              type="button"
              className="team-builder__remove"
              onClick={() => actions.removeMember(idx)}
              title={t('team.removeMember')}
              aria-label={t('team.removeMember')}
            >
              <X size={14} />
            </button>
          </div>
        ))}

        <button
          type="button"
          className="team-builder__add"
          onClick={() => actions.addMember(remaining)}
          disabled={totalNeeded >= remaining}
        >
          <Plus size={14} />
          {t('team.addMember')}
        </button>
      </div>
      <p className="modal__note">{t('team.remaining', { count: remaining })}</p>
    </section>
  );
}

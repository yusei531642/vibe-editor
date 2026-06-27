/**
 * CliAgentSkillsField — CLI custom agent の Skill 選択 + プロジェクト materialize (Issue #1119)。
 *
 * CustomAgentEditor から CLI skill セクションを切り出した子コンポーネント (god-file 回避)。
 * import 済み skill を検索フィルタ付きで列挙し、`defaultSkillIds` をトグルする。「適用」で
 * 選択 skill を現在のプロジェクトの `.claude/skills` へ materialize し、claude/codex の
 * 自動探索で skill が効くようにする。
 */
import { useState } from 'react';
import type { ApiAgentSkillMeta, CliAgentConfig } from '../../../../types/shared';
import { useT } from '../../lib/i18n';
import { useToast } from '../../lib/toast-context';
import { SkillImportPanel } from './SkillImportPanel';

interface Props {
  agent: CliAgentConfig;
  availableSkills: ApiAgentSkillMeta[];
  /** defaultSkillIds をトグルする (永続化は親の patch 経由)。 */
  onToggle: (id: string) => void;
  reloadSkills: () => void;
}

export function CliAgentSkillsField({
  agent,
  availableSkills,
  onToggle,
  reloadSkills
}: Props): JSX.Element {
  const t = useT();
  const { showToast } = useToast();
  const [filter, setFilter] = useState('');

  const matches = (s: ApiAgentSkillMeta): boolean => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return true;
    return `${s.name} ${s.id} ${s.description}`.toLowerCase().includes(needle);
  };

  const apply = async (): Promise<void> => {
    const ids = agent.defaultSkillIds ?? [];
    if (ids.length === 0) {
      showToast(t('settings.customAgents.applySkillsEmpty'), { tone: 'info' });
      return;
    }
    try {
      const res = await window.api.apiAgents.applySkillsToProject(ids);
      const applied = res.filter((r) => r.status === 'created' || r.status === 'updated').length;
      showToast(
        t('settings.customAgents.applySkillsDone', { count: applied, total: res.length }),
        { tone: 'success' }
      );
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      showToast(t('settings.customAgents.applySkillsError', { detail }), {
        tone: 'error',
        duration: 8000
      });
    }
  };

  return (
    <div className="modal__label modal__label--full">
      <span>{t('settings.customAgents.skills')}</span>
      {availableSkills.length === 0 ? (
        <p className="modal__note">{t('settings.customAgents.skillsEmpty')}</p>
      ) : (
        <>
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('settings.customAgents.skillSearch')}
            spellCheck={false}
          />
          <div className="custom-agent__skills">
            {availableSkills.filter(matches).map((skill) => (
              <label key={skill.id} className="custom-agent__skill" title={skill.description}>
                <input
                  type="checkbox"
                  checked={(agent.defaultSkillIds ?? []).includes(skill.id)}
                  onChange={() => onToggle(skill.id)}
                />
                <span className="custom-agent__skill-name">{skill.name}</span>
              </label>
            ))}
          </div>
          <button type="button" className="toolbar__btn" onClick={apply}>
            {t('settings.customAgents.applySkills')}
          </button>
        </>
      )}
      <p className="modal__note">{t('settings.customAgents.cliSkillsNote')}</p>
      <SkillImportPanel onChanged={reloadSkills} />
    </div>
  );
}

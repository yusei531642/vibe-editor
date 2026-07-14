import { describe, expect, it } from 'vitest';
import { buildSkillPreamble } from '../use-skill-injection';
import type { ApiAgentSkillBody } from '../../../../types/shared';

describe('buildSkillPreamble', () => {
  it('returns empty string for no skills', () => {
    expect(buildSkillPreamble([])).toBe('');
  });

  it('formats each skill with a "## Skill: name (id)" header and trimmed body', () => {
    const skills: ApiAgentSkillBody[] = [
      { id: 'alpha', name: 'Alpha', body: '  hello body  \n' },
      { id: 'beta', name: 'Beta', body: 'second' }
    ];
    expect(buildSkillPreamble(skills)).toBe(
      '## Skill: Alpha (alpha)\nhello body\n\n## Skill: Beta (beta)\nsecond'
    );
  });
});

import type { ApiAgentConfig } from '../../../types/shared';

const VIBE_TEAM_SKILL_BODY = `# vibe-team

Use TeamHub tools only when they are available. Coordinate with the team through team_send,
team_read, team_status, team_info, and team_list_role_profiles. Do not invent tool results.
When a tool is unavailable, say what you can do in read-only chat mode.`;

export function buildApiAgentSkills(agent: ApiAgentConfig): { id: string; name: string; body: string }[] {
  const ids = new Set(agent.skillIds ?? []);
  ids.add('vibe-team');
  const out: { id: string; name: string; body: string }[] = [];
  if (ids.has('vibe-team')) {
    out.push({ id: 'vibe-team', name: 'vibe-team', body: VIBE_TEAM_SKILL_BODY });
  }
  return out;
}

import type { TeamMember, TeamRole, TerminalAgent } from '../../../types/shared';

/** Issue #82: label を i18n key に変更。UI 側では `t(AGENT.labelKey)` で解決する。 */
export const AGENTS: { value: TerminalAgent; labelKey: string }[] = [
  { value: 'claude', labelKey: 'team.agent.claude' },
  { value: 'codex', labelKey: 'team.agent.codex' }
];

/** Leader 以外のロール */
export const MEMBER_ROLES: { value: TeamRole; labelKey: string }[] = [
  { value: 'planner', labelKey: 'role.planner' },
  { value: 'programmer', labelKey: 'role.programmer' },
  { value: 'researcher', labelKey: 'role.researcher' },
  { value: 'reviewer', labelKey: 'role.reviewer' }
];

/** ビルトインプリセット。`members` はリーダーを含まない */
export interface BuiltinPreset {
  name: string;
  leaderAgent: TerminalAgent;
  members: TeamMember[];
}

export const BUILTIN_PRESETS: BuiltinPreset[] = [
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

/**
 * Leader を `role: 'leader'` の TeamMember に変換し、非リーダーメンバーと連結した配列を返す。
 * TeamPreset.members と同じ「leader 込み」形式にそろえるユーティリティ。
 */
export function presetFromMembers(
  leaderAgent: TerminalAgent,
  members: TeamMember[]
): TeamMember[] {
  return [{ agent: leaderAgent, role: 'leader' as TeamRole }, ...members];
}

/**
 * 必要な pty 数が残席数に収まるかを判定する。
 * 呼び出し側は builtin (1 + members.length) / saved (members.length) を計算して渡す。
 */
export function canSpawnPreset(totalNeeded: number, remaining: number): boolean {
  return totalNeeded <= remaining;
}

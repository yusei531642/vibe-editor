import type { TeamMember, TeamRole, TerminalAgent } from '../../../types/shared';

export const AGENTS: { value: TerminalAgent; label: string }[] = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' }
];

/** Leader 以外のロール */
export const MEMBER_ROLES: { value: TeamRole; label: string }[] = [
  { value: 'planner', label: 'Planner' },
  { value: 'programmer', label: 'Programmer' },
  { value: 'researcher', label: 'Researcher' },
  { value: 'reviewer', label: 'Reviewer' }
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

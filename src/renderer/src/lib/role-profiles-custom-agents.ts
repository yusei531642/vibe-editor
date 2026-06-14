// role-profiles-custom-agents — 設定の custom agent (CLI/API) を team の role profile に
// 合成する pure helper (Issue #1021)。
//
// これにより custom agent がチーム作成 UI と team_list_role_profiles (MCP 雇用) の両方に出る。
// recruit 時は `useRecruitListener` が id prefix で分岐し、runtime に応じたカードを spawn する。
// React に依存しないため単体テスト・listener から直接 import できる。

import type { AgentConfig, RoleProfile } from '../../../types/shared';

/** custom agent role profile の id prefix。recruit 時にこの prefix で分岐する。 */
export const CUSTOM_AGENT_ROLE_PREFIX = 'custom:';

/** custom agent role profile の id から元の agent id を取り出す。custom でなければ null。 */
export function customAgentIdFromRole(roleProfileId: string): string | null {
  return roleProfileId.startsWith(CUSTOM_AGENT_ROLE_PREFIX)
    ? roleProfileId.slice(CUSTOM_AGENT_ROLE_PREFIX.length)
    : null;
}

/** 設定の custom agent (CLI/API) を team の role profile へ合成する。 */
export function customAgentToProfile(agent: AgentConfig): RoleProfile {
  const label = agent.name?.trim() || agent.id;
  const description =
    agent.runtime === 'api'
      ? `API agent — ${agent.providerId} / ${agent.model}`
      : `CLI agent — ${agent.command || '(no command)'}`;
  return {
    schemaVersion: 1,
    id: `${CUSTOM_AGENT_ROLE_PREFIX}${agent.id}`,
    source: 'user',
    i18n: {
      en: { label, description },
      ja: { label, description }
    },
    visual: {
      color: agent.color ?? '#d97757',
      glyph: label.slice(0, 1).toUpperCase() || '?'
    },
    // CLI/API agent は worker prompt template を使わない (CLI は command 起動 / API は
    // systemPrompt を card 側で扱う)。
    prompt: { template: '' },
    permissions: {
      canRecruit: false,
      canDismiss: false,
      canAssignTasks: false,
      canCreateRoleProfile: false
    },
    // defaultEngine は claude/codex のみの型。custom は recruit 時に id prefix で分岐するため
    // ここはプレースホルダ (実 spawn は engine ではなく runtime で決まる)。
    defaultEngine: 'claude',
    singleton: false
  };
}

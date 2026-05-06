// canvas-layout-helpers.ts
//
// CanvasLayout.tsx から move された pure 関数群 (Phase 4-3 / Issue #373)。

import type {
  HandoffReference,
  Language,
  TeamHistoryEntry,
  TeamOrganizationMeta,
  TeamRole,
  TerminalAgent
} from '../../../types/shared';

export function localeOf(language: Language): string {
  return language === 'ja' ? 'ja-JP' : 'en-US';
}

export function formatCardCount(count: number, language: Language): string {
  return language === 'ja'
    ? `${count} 枚のカード`
    : `${count} ${count === 1 ? 'card' : 'cards'}`;
}

export function formatAgentCount(count: number, language: Language): string {
  return language === 'ja' ? `${count} エージェント` : `${count} agents`;
}

export function formatOrganizationAgentCount(
  organizationCount: number,
  agentCount: number,
  language: Language
): string {
  if (organizationCount <= 1) return formatAgentCount(agentCount, language);
  return language === 'ja'
    ? `${organizationCount} 組織 / ${agentCount} エージェント`
    : `${organizationCount} orgs / ${agentCount} agents`;
}

export function mergeCanvasMembers(
  currentMembers: {
    role: TeamRole;
    agent: TerminalAgent;
    agentId?: string | null;
    sessionId?: string | null;
  }[],
  existingEntry?: TeamHistoryEntry
): TeamHistoryEntry['members'] {
  const existingByAgentId = new Map<string, TeamHistoryEntry['members'][number]>();
  const sessionQueues = new Map<string, Array<string | null>>();
  for (const member of existingEntry?.members ?? []) {
    if (member.agentId) {
      existingByAgentId.set(member.agentId, member);
    }
    const key = `${member.role}:${member.agent}`;
    const queue = sessionQueues.get(key) ?? [];
    queue.push(member.sessionId ?? null);
    sessionQueues.set(key, queue);
  }

  return currentMembers.map((member) => {
    const existingById = member.agentId ? existingByAgentId.get(member.agentId) : undefined;
    const key = `${member.role}:${member.agent}`;
    const queue = sessionQueues.get(key);
    const existingSessionId = existingById?.sessionId ?? (queue && queue.length > 0 ? queue.shift() ?? null : null);
    const sessionId = member.sessionId ?? existingSessionId;
    const merged: TeamHistoryEntry['members'][number] = {
      role: member.role,
      agent: member.agent,
      sessionId
    };
    const agentId = member.agentId ?? existingById?.agentId;
    if (agentId) merged.agentId = agentId;
    if (existingById?.customLabel !== undefined) merged.customLabel = existingById.customLabel;
    return merged;
  });
}

export function serializeAutoSavePayload(payload: {
  byTeam: Map<
    string,
    {
      name: string;
      organization?: TeamOrganizationMeta;
      members?: {
        role: TeamRole;
        agent: TerminalAgent;
        agentId?: string | null;
        sessionId?: string | null;
      }[];
      canvasNodes: { agentId: string; x: number; y: number; width?: number; height?: number }[];
      latestHandoff?: HandoffReference;
    }
  >;
  viewport: { x: number; y: number; zoom: number };
}): string {
  const parts: string[] = [];
  for (const [teamId, info] of payload.byTeam) {
    parts.push(
      `${teamId}|${info.name}|` +
        `org:${info.organization?.id ?? ''}:${info.organization?.name ?? ''}:${info.organization?.color ?? ''}|` +
        `members:${(info.members ?? [])
          .map((m) => `${m.agentId ?? ''}:${m.role}:${m.agent}:${m.sessionId ?? ''}`)
          .sort()
          .join(',')}|` +
        info.canvasNodes
          .map((c) => `${c.agentId}@${c.x},${c.y}:${c.width}x${c.height}`)
          .sort()
          .join(',') +
        `|handoff:${info.latestHandoff?.id ?? ''}:${info.latestHandoff?.status ?? ''}`
    );
  }
  parts.sort();
  return (
    parts.join('##') +
    `##vp:${Math.round(payload.viewport.x)},${Math.round(payload.viewport.y)}:${payload.viewport.zoom.toFixed(2)}`
  );
}

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
import { translate } from './i18n';

// Issue #729: 旧 `formatCardCount` (未参照) は削除。`formatAgentCount` /
// `formatOrganizationAgentCount` の hardcoded JP/EN テンプレートは i18n.ts の
// `canvas.agentCount` / `canvas.orgAgentCount` に集約し、translate() 経由で解決する。

export function localeOf(language: Language): string {
  // BCP47 locale 文字列は Intl.* に渡す用途で、UI 表示テキストではないので
  // i18n.ts には載せず language 引数からマップする。
  return language === 'ja' ? 'ja-JP' : 'en-US';
}

export function formatAgentCount(count: number, language: Language): string {
  return translate(language, 'canvas.agentCount', { count });
}

export function formatOrganizationAgentCount(
  organizationCount: number,
  agentCount: number,
  language: Language
): string {
  if (organizationCount <= 1) return formatAgentCount(agentCount, language);
  return translate(language, 'canvas.orgAgentCount', {
    organizationCount,
    agentCount
  });
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

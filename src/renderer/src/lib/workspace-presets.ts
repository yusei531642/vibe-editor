/**
 * workspace-presets.ts — Canvas に「目的別チーム」を一括配置するプリセット。
 *
 * 各 preset は 「メンバー (ロール+agent)」 + 「画面上の grid 位置」を持つ。
 * Canvas で `applyPreset` するだけで、AgentNode が即座に並ぶ。
 *
 * 固定ワーカーロール撤廃後は Leader が team_recruit で動的にメンバーを増やすため、
 * builtin プリセットは「起動構成」だけを定義する:
 *   - Leader 1 体 (claude / codex)
 *   - Leader + HR (claude / codex)
 */
import type { TeamOrganizationMeta, TeamRole, TerminalAgent } from '../../../types/shared';
import { NODE_H, NODE_W } from '../stores/canvas';

export interface PresetMember {
  role: TeamRole;
  agent: TerminalAgent;
  /** grid 配置 (col, row) — 相対位置 */
  col: number;
  row: number;
}

export interface WorkspacePreset {
  id: string;
  /** ローカライズキー (i18n.ts の `canvas.preset.<id>`) */
  i18nKey: string;
  description: string;
  /** 各メンバーをどのプリセット名でユーザに見せるか (大カテゴリ) */
  category: 'pair' | 'team';
  members: PresetMember[];
  /** Issue #370: 1 プリセットから複数の独立した組織を同時に起動する。 */
  organizations?: PresetOrganization[];
}

export interface PresetOrganization {
  id: string;
  i18nKey: string;
  color: string;
  members: PresetMember[];
}

const CLAUDE_ORG_COLOR = '#d97757';
const CODEX_ORG_COLOR = '#10b981';
const CLAUDE_ORG_ALT_COLOR = '#8b7cf6';
const CODEX_ORG_ALT_COLOR = '#2f80ed';

function defaultOrganizationColor(members: PresetMember[]): string {
  return members[0]?.agent === 'codex' ? CODEX_ORG_COLOR : CLAUDE_ORG_COLOR;
}

export const BUILTIN_PRESETS: WorkspacePreset[] = [
  {
    id: 'leader-claude',
    i18nKey: 'canvas.preset.leaderClaude',
    description: 'Leader (Claude Code) のみで起動。必要なメンバーは Leader が動的に呼び出す。',
    category: 'team',
    members: [{ role: 'leader', agent: 'claude', col: 0, row: 0 }]
  },
  {
    id: 'leader-hr-claude',
    i18nKey: 'canvas.preset.leaderHrClaude',
    description: 'Leader + HR (Claude Code) で起動。HR が大量採用を補助。',
    category: 'team',
    members: [
      { role: 'leader', agent: 'claude', col: 0, row: 0 },
      { role: 'hr', agent: 'claude', col: 1, row: 0 }
    ]
  },
  {
    id: 'leader-codex',
    i18nKey: 'canvas.preset.leaderCodex',
    description: 'Leader (Codex) のみで起動。必要なメンバーは Leader が動的に呼び出す。',
    category: 'team',
    members: [{ role: 'leader', agent: 'codex', col: 0, row: 0 }]
  },
  {
    id: 'leader-hr-codex',
    i18nKey: 'canvas.preset.leaderHrCodex',
    description: 'Leader + HR (Codex) で起動。HR が大量採用を補助。',
    category: 'team',
    members: [
      { role: 'leader', agent: 'codex', col: 0, row: 0 },
      { role: 'hr', agent: 'codex', col: 1, row: 0 }
    ]
  },
  {
    id: 'dual-claude-claude',
    i18nKey: 'canvas.preset.dualClaudeClaude',
    description: 'Claude Code の Leader 組織を 2 つ、独立した teamId で同時起動。',
    category: 'team',
    members: [],
    organizations: [
      {
        id: 'claude-a',
        i18nKey: 'canvas.organization.claudeA',
        color: CLAUDE_ORG_COLOR,
        members: [{ role: 'leader', agent: 'claude', col: 0, row: 0 }]
      },
      {
        id: 'claude-b',
        i18nKey: 'canvas.organization.claudeB',
        color: CLAUDE_ORG_ALT_COLOR,
        members: [{ role: 'leader', agent: 'claude', col: 1, row: 0 }]
      }
    ]
  },
  {
    id: 'dual-claude-codex',
    i18nKey: 'canvas.preset.dualClaudeCodex',
    description: 'Claude Code Leader 組織と Codex Leader 組織を別 teamId で同時起動。',
    category: 'team',
    members: [],
    organizations: [
      {
        id: 'claude',
        i18nKey: 'canvas.organization.claude',
        color: CLAUDE_ORG_COLOR,
        members: [{ role: 'leader', agent: 'claude', col: 0, row: 0 }]
      },
      {
        id: 'codex',
        i18nKey: 'canvas.organization.codex',
        color: CODEX_ORG_COLOR,
        members: [{ role: 'leader', agent: 'codex', col: 1, row: 0 }]
      }
    ]
  },
  {
    id: 'dual-codex-codex',
    i18nKey: 'canvas.preset.dualCodexCodex',
    description: 'Codex の Leader 組織を 2 つ、独立した teamId で同時起動。',
    category: 'team',
    members: [],
    organizations: [
      {
        id: 'codex-a',
        i18nKey: 'canvas.organization.codexA',
        color: CODEX_ORG_COLOR,
        members: [{ role: 'leader', agent: 'codex', col: 0, row: 0 }]
      },
      {
        id: 'codex-b',
        i18nKey: 'canvas.organization.codexB',
        color: CODEX_ORG_ALT_COLOR,
        members: [{ role: 'leader', agent: 'codex', col: 1, row: 0 }]
      }
    ]
  },
  {
    id: 'dual-codex-claude',
    i18nKey: 'canvas.preset.dualCodexClaude',
    description: 'Codex Leader 組織と Claude Code Leader 組織を別 teamId で同時起動。',
    category: 'team',
    members: [],
    organizations: [
      {
        id: 'codex',
        i18nKey: 'canvas.organization.codex',
        color: CODEX_ORG_COLOR,
        members: [{ role: 'leader', agent: 'codex', col: 0, row: 0 }]
      },
      {
        id: 'claude',
        i18nKey: 'canvas.organization.claude',
        color: CLAUDE_ORG_COLOR,
        members: [{ role: 'leader', agent: 'claude', col: 1, row: 0 }]
      }
    ]
  }
];

/** 「チーム起動」ボタンのメイン部分が起動する既定プリセット (Leader-only Claude)。 */
export const DEFAULT_SPAWN_PRESET: WorkspacePreset = BUILTIN_PRESETS[0];

export const GAP = 32;

// Issue #442: 実カードサイズ NODE_W/NODE_H (= 640x400, Issue #253) と乖離した
// 旧定数 (CARD_W=480 / CARD_H=340) で並べていたためカードが重なっていた。
// プリセット配置は Single Source of Truth として stores/canvas の NODE_W/NODE_H に追随させる。
export function presetPosition(col: number, row: number): { x: number; y: number } {
  return {
    x: col * (NODE_W + GAP),
    y: row * (NODE_H + GAP)
  };
}

export function presetMemberCount(preset: WorkspacePreset): number {
  return preset.organizations
    ? preset.organizations.reduce((sum, org) => sum + org.members.length, 0)
    : preset.members.length;
}

export function presetOrganizationCount(preset: WorkspacePreset): number {
  return preset.organizations?.length ?? 1;
}

export function expandPresetOrganizations(
  preset: WorkspacePreset,
  translate: (key: string) => string,
  fallbackName: string
): Array<{
  id: string;
  members: PresetMember[];
  meta: Omit<TeamOrganizationMeta, 'id'>;
}> {
  if (preset.organizations && preset.organizations.length > 0) {
    return preset.organizations.map((org, index) => ({
      id: org.id,
      members: org.members,
      meta: {
        name: translate(org.i18nKey),
        color: org.color,
        index,
        presetId: preset.id
      }
    }));
  }
  return [
    {
      id: 'primary',
      members: preset.members,
      meta: {
        name: fallbackName,
        color: defaultOrganizationColor(preset.members),
        index: 0,
        presetId: preset.id
      }
    }
  ];
}

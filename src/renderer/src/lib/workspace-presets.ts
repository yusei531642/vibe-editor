/**
 * workspace-presets.ts — Canvas に「目的別チーム」を一括配置するプリセット。
 *
 * 各 preset は 「メンバー (ロール+agent)」 + 「画面上の grid 位置」を持つ。
 * Canvas で `applyPreset` するだけで、AgentNode が即座に並ぶ。
 *
 * 固定ワーカーロール撤廃後は Leader が team_recruit で動的にメンバーを増やすため、
 * builtin プリセットは「起動構成」だけを定義する:
 *   - Leader 1 体 (claude / codex)
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
    id: 'leader-codex',
    i18nKey: 'canvas.preset.leaderCodex',
    description: 'Leader (Codex) のみで起動。必要なメンバーは Leader が動的に呼び出す。',
    category: 'team',
    members: [{ role: 'leader', agent: 'codex', col: 0, row: 0 }]
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

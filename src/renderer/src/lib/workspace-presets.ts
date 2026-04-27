/**
 * workspace-presets.ts — Canvas に「目的別チーム」を一括配置するプリセット。
 *
 * 各 preset は 「メンバー (ロール+agent)」 + 「画面上の grid 位置」を持つ。
 * Canvas で `applyPreset` するだけで、AgentNode が即座に並ぶ。
 *
 * Phase 3 では builtin 3 プリセットのみ。Phase 4 以降でユーザー定義 preset
 * (workspaces.json) を追加検討。
 */
import type { TeamRole, TerminalAgent } from '../../../types/shared';

export interface PresetMember {
  role: TeamRole;
  agent: TerminalAgent;
  /** grid 配置 (col, row) — 相対位置 */
  col: number;
  row: number;
}

export interface WorkspacePreset {
  id: string;
  name: string;
  description: string;
  /** 各メンバーをどのプリセット名でユーザに見せるか (大カテゴリ) */
  category: 'pair' | 'team';
  members: PresetMember[];
}

export const BUILTIN_PRESETS: WorkspacePreset[] = [
  {
    // Leader 1 体だけ起動。必要なメンバーは Leader が team_recruit で
    // 動的に追加する (canRecruit / canDismiss / canCreateRoleProfile を
    // 全て leader が持つ)。「チーム起動」ボタン本体はこのプリセットを直接起動する。
    id: 'dynamic-team',
    name: 'Leader のみ (Claude)',
    description: 'Claude の Leader を 1 体起動。必要なメンバーは後から team_recruit で動的に呼び出す。',
    category: 'team',
    members: [{ role: 'leader', agent: 'claude', col: 0, row: 0 }]
  },
  {
    id: 'dynamic-team-codex',
    name: 'Leader のみ (Codex)',
    description: 'Codex の Leader を 1 体起動。必要なメンバーは後から team_recruit で動的に呼び出す。',
    category: 'team',
    members: [{ role: 'leader', agent: 'codex', col: 0, row: 0 }]
  },
  {
    // Leader + HR の 2 体構成。3 名以上を一気に集めたい初期段階で、
    // Leader が `team_send("hr", "...")` で一括採用を委譲できるよう、
    // HR を最初から並べておく便利プリセット。
    id: 'leader-hr',
    name: 'Leader + HR (Claude)',
    description: 'Claude の Leader と HR を起動。Leader は HR に一括採用を委譲してチームを編成できる。',
    category: 'team',
    members: [
      { role: 'leader', agent: 'claude', col: 0, row: 0 },
      { role: 'hr', agent: 'claude', col: 1, row: 0 }
    ]
  },
  {
    id: 'leader-hr-codex',
    name: 'Leader + HR (Codex)',
    description: 'Codex の Leader と HR を起動。Leader は HR に一括採用を委譲してチームを編成できる。',
    category: 'team',
    members: [
      { role: 'leader', agent: 'codex', col: 0, row: 0 },
      { role: 'hr', agent: 'codex', col: 1, row: 0 }
    ]
  }
];

/** 「チーム起動」ボタン本体 (caret ではなく左側) が起動する既定プリセット。 */
export const DEFAULT_SPAWN_PRESET: WorkspacePreset = BUILTIN_PRESETS[0];

export const CARD_W = 480;
export const CARD_H = 340;
export const GAP = 32;

export function presetPosition(col: number, row: number): { x: number; y: number } {
  return {
    x: col * (CARD_W + GAP),
    y: row * (CARD_H + GAP)
  };
}

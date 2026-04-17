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
  category: 'pair' | 'team' | 'review';
  members: PresetMember[];
}

export const BUILTIN_PRESETS: WorkspacePreset[] = [
  {
    id: 'bug-fix',
    name: 'Bug Fix',
    description: 'Researcher が原因調査、Programmer が修正。Reviewer が確認。',
    category: 'team',
    members: [
      { role: 'leader', agent: 'claude', col: 0, row: 0 },
      { role: 'researcher', agent: 'claude', col: 1, row: 0 },
      { role: 'programmer', agent: 'claude', col: 0, row: 1 },
      { role: 'reviewer', agent: 'claude', col: 1, row: 1 }
    ]
  },
  {
    id: 'feature-dev',
    name: 'Feature Dev',
    description: 'Planner が設計、Programmer 2 名で並列実装、Reviewer がチェック。',
    category: 'team',
    members: [
      { role: 'leader', agent: 'claude', col: 0, row: 0 },
      { role: 'planner', agent: 'claude', col: 1, row: 0 },
      { role: 'programmer', agent: 'claude', col: 0, row: 1 },
      { role: 'programmer', agent: 'codex', col: 1, row: 1 },
      { role: 'reviewer', agent: 'claude', col: 2, row: 1 }
    ]
  },
  {
    id: 'code-review',
    name: 'Code Review',
    description: 'Reviewer 中心に複数視点でレビュー。Planner が改善案提示。',
    category: 'review',
    members: [
      { role: 'reviewer', agent: 'claude', col: 0, row: 0 },
      { role: 'reviewer', agent: 'codex', col: 1, row: 0 },
      { role: 'planner', agent: 'claude', col: 0, row: 1 }
    ]
  }
];

export const CARD_W = 480;
export const CARD_H = 340;
export const GAP = 32;

export function presetPosition(col: number, row: number): { x: number; y: number } {
  return {
    x: col * (CARD_W + GAP),
    y: row * (CARD_H + GAP)
  };
}

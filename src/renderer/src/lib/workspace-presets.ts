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
  /** ローカライズキー (i18n.ts の `canvas.preset.<id>`) */
  i18nKey: string;
  description: string;
  /** 各メンバーをどのプリセット名でユーザに見せるか (大カテゴリ) */
  category: 'pair' | 'team';
  members: PresetMember[];
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
  }
];

/** 「チーム起動」ボタンのメイン部分が起動する既定プリセット (Leader-only Claude)。 */
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

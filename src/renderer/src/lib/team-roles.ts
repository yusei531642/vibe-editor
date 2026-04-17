/**
 * team-roles.ts — チームメンバーのロールと表示メタデータ。
 *
 * App.tsx に散在していた ROLE_DESC / ROLE_ORDER を抽出し、Canvas/IDE 両方で
 * 同じ表現を使えるようにする。Phase 3 で AgentNodeCard / HandoffEdge / MiniMap
 * のカラーリングに利用。
 */
import type { TeamRole } from '../../../types/shared';

export interface RoleMeta {
  role: TeamRole;
  /** 日本語ラベル */
  label: string;
  /** 一行の役割説明 (システムプロンプト等で利用) */
  description: string;
  /** ノード/エッジ/バッジに使う基底色 (`var()` ではなく hex で持ち、CSS で透過調整しやすく) */
  color: string;
  /** 背景に乗せるグラデの second stop */
  accent: string;
  /** 1 文字アイコン (lucide なし版、AgentNode のアバター用) */
  glyph: string;
}

export const ROLE_META: Record<TeamRole, RoleMeta> = {
  leader: {
    role: 'leader',
    label: 'Leader',
    description: 'チーム全体の方針とハンドオフを統括するリーダー。',
    color: '#a78bfa',
    accent: '#7c3aed',
    glyph: 'L'
  },
  planner: {
    role: 'planner',
    label: 'Planner',
    description: 'ゴールから逆算してタスクを分解する設計担当。',
    color: '#7aa2ff',
    accent: '#3b82f6',
    glyph: 'P'
  },
  programmer: {
    role: 'programmer',
    label: 'Programmer',
    description: '実装と修正、テスト、コミットを担当する実装者。',
    color: '#39d39f',
    accent: '#10b981',
    glyph: 'C'
  },
  researcher: {
    role: 'researcher',
    label: 'Researcher',
    description: 'ドキュメント・既存コード・外部資料の調査担当。',
    color: '#f5b048',
    accent: '#f59e0b',
    glyph: 'R'
  },
  reviewer: {
    role: 'reviewer',
    label: 'Reviewer',
    description: '実装結果のレビューと品質チェックを担当する監査役。',
    color: '#f06060',
    accent: '#ef4444',
    glyph: 'V'
  }
};

/** UI 表示順 (Leader 先頭、以降は plan→prog→research→review) */
export const ROLE_ORDER: TeamRole[] = ['leader', 'planner', 'programmer', 'researcher', 'reviewer'];

const ROLE_RANK: Record<string, number> = Object.fromEntries(
  ROLE_ORDER.map((r, i) => [r as string, i])
);

export interface TeamMemberSeed {
  agentId: string;
  role: TeamRole;
  agent: 'claude' | 'codex';
}

/**
 * チーム所属 agent に渡すシステムプロンプトを組み立てる。
 * App.tsx の generateTeamSystemPrompt と同等の内容を Canvas 向けに再実装。
 */
export function buildTeamSystemPrompt(
  selfAgentId: string,
  selfRole: TeamRole,
  teamName: string,
  members: TeamMemberSeed[]
): string {
  const sorted = members
    .slice()
    .sort((a, b) => {
      const ra = ROLE_RANK[a.role] ?? 99;
      const rb = ROLE_RANK[b.role] ?? 99;
      if (ra !== rb) return ra - rb;
      return a.agentId.localeCompare(b.agentId);
    });
  const roster = sorted
    .map((m) => {
      const label = ROLE_META[m.role]?.label ?? m.role;
      const agentName = m.agent === 'claude' ? 'Claude Code' : 'Codex';
      const you = m.agentId === selfAgentId ? ' ← あなた' : '';
      return `${label}(${agentName})${you}`;
    })
    .join(', ');

  const mcpTools =
    'MCP vive-team ツール: team_send(to,message) / team_assign_task(assignee,description) / team_get_tasks() / team_update_task(task_id,status) / team_info() / team_status(status) / team_read(). ' +
    'team_send/team_assign_task で送ったメッセージは相手のプロンプトにリアルタイム注入されるので、受信側はポーリング不要。受信時は [Team ← <role>] プレフィックス付きで入力に届く。';

  if (selfRole === 'leader') {
    return `あなたはチーム「${teamName}」のLeader。構成: ${roster}。${mcpTools} 重要: ユーザーから最初の指示が来るまで何もせず待機してください。自分からプロジェクト調査やタスク割振を開始してはいけません。ユーザー指示を受け取ってから、1)必要に応じて調査 2)計画立案 3)team_assign_taskで割振 4)結果は [Team ← ...] で届くので都度レビューし team_send で追指示 の順で進めてください。`;
  }
  const desc = ROLE_META[selfRole]?.description ?? '';
  return `あなたはチーム「${teamName}」の${selfRole}。役割:${desc} 構成: ${roster}。${mcpTools} 重要: Leaderからの指示を受け取るまで何もせず待機してください。自分からプロジェクト調査やコード変更を始めてはいけません。Leaderからの指示は [Team ← leader] 形式で入力に届くので、それを受け取ってから作業を開始し、完了後は team_send('leader', ...) で報告してください。`;
}

export function colorOf(role: string | undefined): string {
  if (!role) return '#7a7afd';
  return ROLE_META[role as TeamRole]?.color ?? '#7a7afd';
}

export function metaOf(role: string | undefined): RoleMeta | null {
  if (!role) return null;
  return ROLE_META[role as TeamRole] ?? null;
}

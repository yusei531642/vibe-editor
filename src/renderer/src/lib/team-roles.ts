/**
 * team-roles.ts — チームメンバーのロールと表示メタデータ。
 *
 * App.tsx に散在していた ROLE_DESC / ROLE_ORDER を抽出し、Canvas/IDE 両方で
 * 同じ表現を使えるようにする。Phase 3 で AgentNodeCard / HandoffEdge / MiniMap
 * のカラーリングに利用。
 */
import type { Language, TeamRole } from '../../../types/shared';

export interface RoleMeta {
  role: TeamRole;
  /** 日本語ラベル */
  label: string;
  /** 一行の役割説明 (システムプロンプト等で利用) */
  description: string;
  /** Issue #70: English 説明 (system prompt が English 環境で日本語にならないよう分ける) */
  descriptionEn?: string;
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
    descriptionEn: 'The leader who directs the team strategy and handoffs.',
    color: '#a78bfa',
    accent: '#7c3aed',
    glyph: 'L'
  },
  planner: {
    role: 'planner',
    label: 'Planner',
    description: 'ゴールから逆算してタスクを分解する設計担当。',
    descriptionEn: 'Breaks down goals into tasks and owns the plan.',
    color: '#7aa2ff',
    accent: '#3b82f6',
    glyph: 'P'
  },
  programmer: {
    role: 'programmer',
    label: 'Programmer',
    description: '実装と修正、テスト、コミットを担当する実装者。',
    descriptionEn: 'Implements changes, writes tests, and commits code.',
    color: '#39d39f',
    accent: '#10b981',
    glyph: 'C'
  },
  researcher: {
    role: 'researcher',
    label: 'Researcher',
    description: 'ドキュメント・既存コード・外部資料の調査担当。',
    descriptionEn: 'Investigates docs, existing code, and external references.',
    color: '#f5b048',
    accent: '#f59e0b',
    glyph: 'R'
  },
  reviewer: {
    role: 'reviewer',
    label: 'Reviewer',
    description: '実装結果のレビューと品質チェックを担当する監査役。',
    descriptionEn: 'Reviews implementation results and enforces quality.',
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
 *
 * Issue #70: UI 言語に応じて日本語 / 英語のプロンプトを切り替える。
 * lang を明示的に渡さない呼び出しは後方互換のため日本語 (ja) を使う。
 */
export function buildTeamSystemPrompt(
  selfAgentId: string,
  selfRole: TeamRole,
  teamName: string,
  members: TeamMemberSeed[],
  lang: Language = 'ja'
): string {
  const sorted = members
    .slice()
    .sort((a, b) => {
      const ra = ROLE_RANK[a.role] ?? 99;
      const rb = ROLE_RANK[b.role] ?? 99;
      if (ra !== rb) return ra - rb;
      return a.agentId.localeCompare(b.agentId);
    });
  const youLabel = lang === 'en' ? ' ← you' : ' ← あなた';
  const roster = sorted
    .map((m) => {
      const label = ROLE_META[m.role]?.label ?? m.role;
      const agentName = m.agent === 'claude' ? 'Claude Code' : 'Codex';
      const you = m.agentId === selfAgentId ? youLabel : '';
      return `${label}(${agentName})${you}`;
    })
    .join(', ');

  if (lang === 'en') {
    const mcpTools =
      'MCP vibe-team tools: team_send(to,message) / team_assign_task(assignee,description) / team_get_tasks() / team_update_task(task_id,status) / team_info() / team_status(status) / team_read(). ' +
      'Messages sent via team_send/team_assign_task are injected into the recipient prompt in real time, so polling is unnecessary. Incoming messages arrive prefixed with [Team ← <role>].';
    if (selfRole === 'leader') {
      return `You are the Leader of the team "${teamName}". Members: ${roster}. ${mcpTools} Important: wait until the user gives you the first instruction — do NOT start investigating the project or assigning tasks on your own. After the user instructs you: 1) investigate if needed, 2) plan, 3) team_assign_task to delegate, 4) review results that arrive as [Team ← ...] and follow up via team_send.`;
    }
    const descEn = ROLE_META[selfRole]?.descriptionEn ?? '';
    return `You are the ${selfRole} on the team "${teamName}". Role: ${descEn} Members: ${roster}. ${mcpTools} Important: wait for the Leader's instructions before doing anything — do NOT start investigating or modifying code on your own. Instructions from the Leader arrive prefixed with [Team ← leader]; once received, do the work and report back with team_send('leader', ...) when done.`;
  }

  const mcpTools =
    'MCP vibe-team ツール: team_send(to,message) / team_assign_task(assignee,description) / team_get_tasks() / team_update_task(task_id,status) / team_info() / team_status(status) / team_read(). ' +
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

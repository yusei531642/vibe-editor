/**
 * team-roles.ts — チームメンバーのロールと表示メタデータ。
 *
 * Issue #70 / #82: ロール名 / 説明 / system prompt は言語で切り替える。
 * ROLE_META は後方互換のため「ラベル/説明の固定値」を残しつつ、言語別版 (ROLE_META_I18N)
 * を用意して上書きできるようにする。
 */
import type { Language, TeamRole } from '../../../types/shared';

export interface RoleMeta {
  role: TeamRole;
  /** ラベル (UI 表示用、既定は英語) */
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

/** 言語別 label + description。色/glyph はここに含めず ROLE_META から引く */
const ROLE_TEXT: Record<Language, Record<TeamRole, { label: string; description: string }>> = {
  ja: {
    leader: {
      label: 'リーダー',
      description: 'チーム全体の方針とハンドオフを統括するリーダー。'
    },
    planner: {
      label: 'プランナー',
      description: 'ゴールから逆算してタスクを分解する設計担当。'
    },
    programmer: {
      label: 'プログラマー',
      description: '実装と修正、テスト、コミットを担当する実装者。'
    },
    researcher: {
      label: 'リサーチャー',
      description: 'ドキュメント・既存コード・外部資料の調査担当。'
    },
    reviewer: {
      label: 'レビュアー',
      description: '実装結果のレビューと品質チェックを担当する監査役。'
    }
  },
  en: {
    leader: {
      label: 'Leader',
      description:
        'Leads the overall strategy and hand-offs for the team.'
    },
    planner: {
      label: 'Planner',
      description:
        'Breaks down goals into concrete tasks by reasoning backwards.'
    },
    programmer: {
      label: 'Programmer',
      description:
        'Owns implementation, fixes, tests, and commits.'
    },
    researcher: {
      label: 'Researcher',
      description:
        'Investigates docs, existing code, and external references.'
    },
    reviewer: {
      label: 'Reviewer',
      description:
        'Reviews implementation and performs quality checks.'
    }
  }
};

/** 後方互換の固定 ROLE_META (英語 label を既定値として export)。
 *  新規コードは roleMetaFor(language) を優先する。 */
export const ROLE_META: Record<TeamRole, RoleMeta> = {
  leader: {
    role: 'leader',
    label: ROLE_TEXT.en.leader.label,
    description: ROLE_TEXT.en.leader.description,
    color: '#a78bfa',
    accent: '#7c3aed',
    glyph: 'L'
  },
  planner: {
    role: 'planner',
    label: ROLE_TEXT.en.planner.label,
    description: ROLE_TEXT.en.planner.description,
    color: '#7aa2ff',
    accent: '#3b82f6',
    glyph: 'P'
  },
  programmer: {
    role: 'programmer',
    label: ROLE_TEXT.en.programmer.label,
    description: ROLE_TEXT.en.programmer.description,
    color: '#39d39f',
    accent: '#10b981',
    glyph: 'C'
  },
  researcher: {
    role: 'researcher',
    label: ROLE_TEXT.en.researcher.label,
    description: ROLE_TEXT.en.researcher.description,
    color: '#f5b048',
    accent: '#f59e0b',
    glyph: 'R'
  },
  reviewer: {
    role: 'reviewer',
    label: ROLE_TEXT.en.reviewer.label,
    description: ROLE_TEXT.en.reviewer.description,
    color: '#f06060',
    accent: '#ef4444',
    glyph: 'V'
  }
};

/** language に応じた ROLE_META を返す */
export function roleMetaFor(role: TeamRole, language: Language): RoleMeta {
  const base = ROLE_META[role];
  const text = ROLE_TEXT[language]?.[role];
  if (!text) return base;
  return { ...base, label: text.label, description: text.description };
}

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
  members: TeamMemberSeed[],
  // Issue #70: language 指定で英/日を切り替える。省略時は 'en' (LLM に英語で指示するほうが安全)。
  language: Language = 'en'
): string {
  const sorted = members
    .slice()
    .sort((a, b) => {
      const ra = ROLE_RANK[a.role] ?? 99;
      const rb = ROLE_RANK[b.role] ?? 99;
      if (ra !== rb) return ra - rb;
      return a.agentId.localeCompare(b.agentId);
    });

  if (language === 'ja') {
    const roster = sorted
      .map((m) => {
        const label = ROLE_TEXT.ja[m.role]?.label ?? m.role;
        const agentName = m.agent === 'claude' ? 'Claude Code' : 'Codex';
        const you = m.agentId === selfAgentId ? ' ← あなた' : '';
        return `${label}(${agentName})${you}`;
      })
      .join(', ');
    const mcpTools =
      'MCP vibe-team ツール: team_send(to,message) / team_assign_task(assignee,description) / team_get_tasks() / team_update_task(task_id,status) / team_info() / team_status(status) / team_read(). ' +
      'team_send/team_assign_task で送ったメッセージは相手のプロンプトにリアルタイム注入されるので、受信側はポーリング不要。受信時は [Team ← <role>] プレフィックス付きで入力に届く。';
    if (selfRole === 'leader') {
      return `あなたはチーム「${teamName}」のLeader。構成: ${roster}。${mcpTools} 重要: ユーザーから最初の指示が来るまで何もせず待機してください。自分からプロジェクト調査やタスク割振を開始してはいけません。ユーザー指示を受け取ってから、1)必要に応じて調査 2)計画立案 3)team_assign_taskで割振 4)結果は [Team ← ...] で届くので都度レビューし team_send で追指示 の順で進めてください。`;
    }
    const desc = ROLE_TEXT.ja[selfRole]?.description ?? '';
    return `あなたはチーム「${teamName}」の${selfRole}。役割:${desc} 構成: ${roster}。${mcpTools} 重要: Leaderからの指示を受け取るまで何もせず待機してください。自分からプロジェクト調査やコード変更を始めてはいけません。Leaderからの指示は [Team ← leader] 形式で入力に届くので、それを受け取ってから作業を開始し、完了後は team_send('leader', ...) で報告してください。`;
  }

  // English (default)
  const roster = sorted
    .map((m) => {
      const label = ROLE_TEXT.en[m.role]?.label ?? m.role;
      const agentName = m.agent === 'claude' ? 'Claude Code' : 'Codex';
      const you = m.agentId === selfAgentId ? ' <-- you' : '';
      return `${label}(${agentName})${you}`;
    })
    .join(', ');
  const mcpTools =
    'MCP vibe-team tools: team_send(to,message) / team_assign_task(assignee,description) / team_get_tasks() / team_update_task(task_id,status) / team_info() / team_status(status) / team_read(). ' +
    'Messages sent via team_send/team_assign_task are injected directly into the recipient agent prompt in real time (no polling). Incoming messages arrive as `[Team <- <role>] ...`.';
  if (selfRole === 'leader') {
    return `You are the Leader of team "${teamName}". Roster: ${roster}. ${mcpTools} IMPORTANT: Wait for the user's first instruction before doing anything. Do not start investigating the project or assigning tasks on your own. After the user instructs you, proceed in this order: (1) investigate if needed, (2) plan, (3) assign via team_assign_task, (4) review each result delivered as [Team <- ...] and follow up with team_send.`;
  }
  const desc = ROLE_TEXT.en[selfRole]?.description ?? '';
  return `You are the ${selfRole} of team "${teamName}". Role: ${desc} Roster: ${roster}. ${mcpTools} IMPORTANT: Wait for instructions from the Leader before doing anything. Do not investigate or modify code on your own. Leader instructions arrive as [Team <- leader] in your input; start working only after receiving them, and report back via team_send('leader', ...).`;
}

export function colorOf(role: string | undefined): string {
  if (!role) return '#7a7afd';
  return ROLE_META[role as TeamRole]?.color ?? '#7a7afd';
}

export function metaOf(role: string | undefined): RoleMeta | null {
  if (!role) return null;
  return ROLE_META[role as TeamRole] ?? null;
}

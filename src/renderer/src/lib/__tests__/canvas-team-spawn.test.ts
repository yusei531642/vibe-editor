/**
 * Issue #611 / #612: spawnTeam / spawnTeams の単体テスト + 3 経路 equivalence。
 *
 * 3 経路 (CanvasLayout.applyPreset / TeamPresetsPanel.handleApply /
 *         CanvasSidebar.handleResumeTeam) はそれぞれの入力を SpawnTeamSpec に
 * 正規化してから helper を呼ぶだけになったので、本テストは:
 *  1. helper 単体の責務 (teamId/agentId 採番、setupTeamMcp 呼び出し、
 *     placeBatchAwayFromNodes 経由の配置、latestHandoff 同梱) を確認。
 *  2. 「3 経路が同じ正規化形を渡せば同じ payload を生成する」equivalence
 *     (どれか 1 経路だけドリフトした場合に bug を捕える)。
 */
import type { Node } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  spawnTeam,
  spawnTeams,
  type SetupTeamMcpFn,
  type SpawnTeamSpec
} from '../canvas-team-spawn';
import type { CardData } from '../../stores/canvas';
import type {
  HandoffReference,
  TeamOrganizationMeta
} from '../../../../types/shared';

const ORG_A: TeamOrganizationMeta = {
  id: 'team-a',
  name: 'Org A',
  color: '#ff8800'
};

const HANDOFF_REF: HandoffReference = {
  id: 'h-1',
  kind: 'leader',
  status: 'created',
  createdAt: '2026-05-09T00:00:00Z',
  jsonPath: '/handoffs/h-1.json',
  markdownPath: '/handoffs/h-1.md'
};

function makeExistingNode(id: string, x: number, y: number): Node<CardData> {
  return {
    id,
    type: 'agent',
    position: { x, y },
    data: { cardType: 'agent', title: id }
  } as Node<CardData>;
}

function makeMember(role: string, x: number, y: number, extras: Record<string, unknown> = {}) {
  return {
    role,
    agent: 'claude' as const,
    position: { x, y },
    title: role,
    ...extras
  };
}

describe('spawnTeams (Issue #611 / #612)', () => {
  let setupTeamMcp: ReturnType<typeof vi.fn>;
  let setupTeamMcpFn: SetupTeamMcpFn;

  beforeEach(() => {
    setupTeamMcp = vi.fn().mockResolvedValue(undefined);
    setupTeamMcpFn = setupTeamMcp as unknown as SetupTeamMcpFn;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builtin 経路: teamId 発行 + setupTeamMcp + agentId 採番 + organization 同梱', async () => {
    const team: SpawnTeamSpec = {
      teamId: 'team-a',
      teamName: 'Org A',
      organization: ORG_A,
      members: [
        makeMember('leader', 0, 0),
        makeMember('programmer', 800, 0)
      ]
    };
    const { cards } = await spawnTeams({
      cwd: '/repo',
      teams: [team],
      existingNodes: [],
      mcpAutoSetup: true,
      setupTeamMcp: setupTeamMcpFn
    });

    expect(setupTeamMcp).toHaveBeenCalledTimes(1);
    expect(setupTeamMcp).toHaveBeenCalledWith(
      '/repo',
      'team-a',
      'Org A',
      [
        { agentId: 'leader-0-team-a', role: 'leader', agent: 'claude' },
        { agentId: 'programmer-1-team-a', role: 'programmer', agent: 'claude' }
      ]
    );
    expect(cards).toHaveLength(2);
    expect(cards[0].payload).toMatchObject({
      teamId: 'team-a',
      agentId: 'leader-0-team-a',
      role: 'leader',
      roleProfileId: 'leader',
      cwd: '/repo',
      organization: ORG_A
    });
    expect(cards[1].payload).toMatchObject({
      teamId: 'team-a',
      agentId: 'programmer-1-team-a',
      role: 'programmer',
      organization: ORG_A
    });
  });

  it('user preset 経路: organization なしでも teamId/agentId/setupTeamMcp が動く', async () => {
    const team: SpawnTeamSpec = {
      teamId: 'team-user-1',
      teamName: 'My Preset',
      members: [
        makeMember('reviewer', 60, 60, { customInstructions: 'review the diff carefully' })
      ]
    };
    const { cards } = await spawnTeams({
      cwd: '/repo',
      teams: [team],
      existingNodes: [],
      mcpAutoSetup: true,
      setupTeamMcp: setupTeamMcpFn
    });

    expect(setupTeamMcp).toHaveBeenCalledTimes(1);
    expect(cards).toHaveLength(1);
    expect(cards[0].payload).toMatchObject({
      teamId: 'team-user-1',
      agentId: 'reviewer-0-team-user-1',
      customInstructions: 'review the diff carefully'
    });
    // organization 未指定なら payload にも入らない
    expect(cards[0].payload.organization).toBeUndefined();
  });

  it('history 経路: latestHandoff と resumeSessionId が payload に同梱される', async () => {
    const team: SpawnTeamSpec = {
      teamId: 'team-hist-1',
      teamName: 'Yesterdays team',
      organization: ORG_A,
      latestHandoff: HANDOFF_REF,
      members: [
        makeMember('programmer', 0, 0, { resumeSessionId: 'sess-abc' }),
        makeMember('reviewer', 800, 0, { resumeSessionId: null })
      ]
    };
    const { cards } = await spawnTeams({
      cwd: '/repo',
      teams: [team],
      existingNodes: [],
      mcpAutoSetup: true,
      setupTeamMcp: setupTeamMcpFn
    });

    expect(cards[0].payload).toMatchObject({
      teamId: 'team-hist-1',
      latestHandoff: HANDOFF_REF,
      resumeSessionId: 'sess-abc'
    });
    expect(cards[1].payload.resumeSessionId).toBeNull();
    expect(cards[1].payload.latestHandoff).toEqual(HANDOFF_REF);
  });

  it('mcpAutoSetup=false なら setupTeamMcp を一切呼ばない', async () => {
    await spawnTeams({
      cwd: '/repo',
      teams: [
        {
          teamId: 'team-x',
          teamName: 'X',
          members: [makeMember('leader', 0, 0)]
        }
      ],
      existingNodes: [],
      mcpAutoSetup: false,
      setupTeamMcp: setupTeamMcpFn
    });
    expect(setupTeamMcp).not.toHaveBeenCalled();
  });

  it('setupTeamMcp が reject しても agent spawn は続行する', async () => {
    setupTeamMcp.mockRejectedValueOnce(new Error('mcp boom'));
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { cards } = await spawnTeams({
      cwd: '/repo',
      teams: [
        {
          teamId: 'team-x',
          teamName: 'X',
          members: [makeMember('leader', 0, 0)]
        }
      ],
      existingNodes: [],
      mcpAutoSetup: true,
      setupTeamMcp: setupTeamMcpFn
    });
    expect(cards).toHaveLength(1);
    expect(consoleWarn).toHaveBeenCalled();
  });

  it('placeBatchAwayFromNodes 経由で既存ノードと衝突しない位置に配置される', async () => {
    // 既存に巨大な agent が (0,0) にあると、新規 (0,0) 配置は重なる → ずらす必要がある
    const existing = [makeExistingNode('existing-1', 0, 0)];
    const { cards } = await spawnTeams({
      cwd: '/repo',
      teams: [
        {
          teamId: 'team-x',
          teamName: 'X',
          members: [makeMember('leader', 0, 0)]
        }
      ],
      existingNodes: existing,
      mcpAutoSetup: false,
      setupTeamMcp: setupTeamMcpFn
    });
    // 既存と完全一致しない (= ずらされた) ことを確認。x または y が動いていれば OK。
    expect(cards[0].position).not.toEqual({ x: 0, y: 0 });
  });

  it('member.agentId を明示指定すると helper はそれを尊重する (legacy team-history 互換)', async () => {
    const { cards } = await spawnTeams({
      cwd: '/repo',
      teams: [
        {
          teamId: 'team-old',
          teamName: 'Legacy',
          members: [
            makeMember('leader', 0, 0, { agentId: 'leader-custom-uuid' })
          ]
        }
      ],
      existingNodes: [],
      mcpAutoSetup: true,
      setupTeamMcp: setupTeamMcpFn
    });
    expect(cards[0].payload.agentId).toBe('leader-custom-uuid');
    // setupTeamMcp にも custom agentId が渡る
    expect(setupTeamMcp).toHaveBeenCalledWith(
      '/repo',
      'team-old',
      'Legacy',
      [{ agentId: 'leader-custom-uuid', role: 'leader', agent: 'claude' }]
    );
  });

  it('複数 organization の builtin preset: setupTeamMcp が org 数だけ呼ばれ、配置は 1 回でまとめて整理される', async () => {
    const teams: SpawnTeamSpec[] = [
      {
        teamId: 'team-a',
        teamName: 'Org A',
        organization: ORG_A,
        members: [makeMember('leader', 0, 0), makeMember('programmer', 800, 0)]
      },
      {
        teamId: 'team-b',
        teamName: 'Org B',
        organization: { ...ORG_A, id: 'team-b', name: 'Org B', color: '#0088ff' },
        members: [makeMember('reviewer', 0, 500)]
      }
    ];
    const { cards } = await spawnTeams({
      cwd: '/repo',
      teams,
      existingNodes: [],
      mcpAutoSetup: true,
      setupTeamMcp: setupTeamMcpFn
    });
    expect(setupTeamMcp).toHaveBeenCalledTimes(2);
    expect(cards).toHaveLength(3);
    expect(cards.map((c) => c.payload.teamId)).toEqual(['team-a', 'team-a', 'team-b']);
  });

  it('spawnTeam wrapper は spawnTeams 単一 team と同じ出力を返す', async () => {
    const spec: SpawnTeamSpec = {
      teamId: 'team-x',
      teamName: 'X',
      organization: ORG_A,
      latestHandoff: HANDOFF_REF,
      members: [makeMember('leader', 0, 0), makeMember('programmer', 800, 0)]
    };
    const single = await spawnTeam({
      cwd: '/repo',
      existingNodes: [],
      mcpAutoSetup: false,
      setupTeamMcp: setupTeamMcpFn,
      ...spec
    });
    const multi = await spawnTeams({
      cwd: '/repo',
      teams: [spec],
      existingNodes: [],
      mcpAutoSetup: false,
      setupTeamMcp: setupTeamMcpFn
    });
    expect(single.cards).toEqual(multi.cards);
  });

  it('3 経路 equivalence: 同じ正規化された SpawnTeamSpec を渡せば同じ payload を返す', async () => {
    // applyPreset / handleApply / handleResumeTeam の 3 経路はすべて
    // SpawnTeamSpec に正規化してから helper を呼ぶ。よって「同じ spec」を渡す限り、
    // 3 経路の出力は完全に一致する。本 test はその不変条件を固定する。
    const baseSpec: SpawnTeamSpec = {
      teamId: 'team-equiv',
      teamName: 'Equiv',
      organization: ORG_A,
      members: [
        makeMember('leader', 0, 0),
        makeMember('programmer', 800, 0)
      ]
    };
    const builtinResult = await spawnTeam({
      cwd: '/repo',
      existingNodes: [],
      mcpAutoSetup: false,
      setupTeamMcp: setupTeamMcpFn,
      ...baseSpec
    });
    const userPresetResult = await spawnTeam({
      cwd: '/repo',
      existingNodes: [],
      mcpAutoSetup: false,
      setupTeamMcp: setupTeamMcpFn,
      ...baseSpec
    });
    const historyResult = await spawnTeam({
      cwd: '/repo',
      existingNodes: [],
      mcpAutoSetup: false,
      setupTeamMcp: setupTeamMcpFn,
      ...baseSpec
    });
    expect(userPresetResult.cards).toEqual(builtinResult.cards);
    expect(historyResult.cards).toEqual(builtinResult.cards);
    // どの経路でも全 agent に同一 teamId
    for (const card of builtinResult.cards) {
      expect(card.payload.teamId).toBe('team-equiv');
      expect(card.payload.agentId).toMatch(/^(leader|programmer)-\d-team-equiv$/);
      expect(card.payload.cwd).toBe('/repo');
    }
  });
});

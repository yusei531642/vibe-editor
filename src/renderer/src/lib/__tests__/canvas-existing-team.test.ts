import type { Node } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import { findExistingTeamNode } from '../canvas-existing-team';
import type { CardData } from '../../stores/canvas';

function teamNode(id: string, teamId?: string): Node<CardData> {
  return {
    id,
    type: 'agent',
    position: { x: 0, y: 0 },
    data: {
      cardType: 'agent',
      title: id,
      payload: teamId ? { teamId } : undefined
    }
  } as Node<CardData>;
}

describe('findExistingTeamNode (Issue #893)', () => {
  it('同じ teamId を持つ既存ノードを返す', () => {
    const nodes = [teamNode('a', 'team-a'), teamNode('b', 'team-b')];

    expect(findExistingTeamNode(nodes, 'team-b')?.id).toBe('b');
  });

  it('teamId が一致しない場合は undefined を返す', () => {
    const nodes = [teamNode('a', 'team-a'), teamNode('loose')];

    expect(findExistingTeamNode(nodes, 'team-missing')).toBeUndefined();
  });
});

import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { CardData } from '../../stores/canvas';

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  ackRecruit: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, cb: (e: { payload: unknown }) => void) => {
    mocks.listeners.set(event, cb);
    return () => mocks.listeners.delete(event);
  })
}));

vi.mock('../recruit-ack', () => ({
  ackRecruit: (...args: unknown[]) => mocks.ackRecruit(...args)
}));

vi.mock('../tauri-api', () => ({
  api: {
    teamState: {
      recruitObservedWhileHidden: vi.fn().mockResolvedValue(undefined)
    }
  }
}));

vi.mock('../role-profiles-context', () => ({
  useRoleProfiles: () => ({ registerDynamicRole: vi.fn() })
}));

vi.mock('../toast-context', () => ({
  useToast: () => ({ showToast: vi.fn() })
}));

vi.mock('../i18n', () => ({
  useT: () => (key: string) => key
}));

vi.mock('../use-canvas-visibility', () => ({
  getHiddenSinceMs: () => null,
  isCanvasVisibleNow: () => true,
  subscribeOnVisible: () => () => {}
}));

import { useRecruitListener } from '../use-recruit-listener';
import { cardAgentId, useCanvasStore } from '../../stores/canvas';

function Harness(): null {
  useRecruitListener();
  return null;
}

function requesterNode(): Node<CardData> {
  return {
    id: 'leader-card',
    type: 'agent',
    position: { x: 0, y: 0 },
    data: {
      cardType: 'agent',
      title: 'Leader',
      payload: {
        agent: 'claude',
        roleProfileId: 'leader',
        role: 'leader',
        teamId: 'team-alpha',
        teamName: 'Alpha Team',
        agentId: 'leader-1',
        organization: { id: 'org-alpha', name: 'Alpha Team', color: '#ff8800' }
      }
    },
    style: { width: 760, height: 460 }
  } as Node<CardData>;
}

describe('useRecruitListener teamName propagation (Issue #896)', () => {
  beforeEach(() => {
    mocks.listeners.clear();
    mocks.ackRecruit.mockClear();
    useCanvasStore.setState({
      nodes: [requesterNode()],
      edges: [],
      teamLocks: {}
    } as never);
  });

  afterEach(() => {
    cleanup();
    useCanvasStore.setState({ nodes: [], edges: [], teamLocks: {} } as never);
    vi.clearAllMocks();
  });

  it('動的採用で追加される worker payload に依頼元の teamName を引き継ぐ', async () => {
    render(<Harness />);

    await waitFor(() => {
      expect(mocks.listeners.get('team:recruit-request')).toBeTruthy();
    });

    mocks.listeners.get('team:recruit-request')?.({
      payload: {
        teamId: 'team-alpha',
        requesterAgentId: 'leader-1',
        requesterRole: 'leader',
        newAgentId: 'worker-1',
        roleProfileId: 'programmer',
        engine: 'claude',
        agentLabelHint: 'Programmer'
      }
    });

    await waitFor(() => {
      expect(useCanvasStore.getState().nodes).toHaveLength(2);
    });

    const worker = useCanvasStore
      .getState()
      .nodes.find((node) => cardAgentId(node.data) === 'worker-1');
    expect(worker?.data.payload).toMatchObject({
      teamId: 'team-alpha',
      teamName: 'Alpha Team',
      agentId: 'worker-1'
    });
    expect(mocks.ackRecruit).toHaveBeenCalledWith('worker-1', 'team-alpha', {
      ok: true
    });
  });
});

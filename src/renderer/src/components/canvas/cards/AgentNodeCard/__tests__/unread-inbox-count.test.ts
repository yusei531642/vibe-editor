/**
 * Issue #596: AgentNodeCard の unreadInboxCount race fix の単体テスト。
 *
 * 旧実装は closure-captured payload を読んでから setCardPayload で書き戻していたため、
 * 1 frame (16ms) 以内に同 agentId へ複数 handoff/inbox_read が来ると undercount した。
 * 本テストは「同 tick 連続呼び出しでも store の最新値を base に書く」ことを検証する。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '../../../../../stores/canvas';
import { applyHandoffArrival, applyInboxRead } from '../unread-inbox-count';

function setStoreNodes(
  nodes: { id: string; agentId?: string; unreadInboxCount?: number; oldestUnreadDeliveredAt?: string }[]
): void {
  useCanvasStore.setState({
    nodes: nodes.map((n) => ({
      id: n.id,
      type: 'agent',
      position: { x: 0, y: 0 },
      data: {
        cardType: 'agent' as const,
        title: n.id,
        payload: {
          agentId: n.agentId,
          unreadInboxCount: n.unreadInboxCount,
          oldestUnreadDeliveredAt: n.oldestUnreadDeliveredAt
        }
      }
    })) as never,
    edges: [],
    teamLocks: {}
  } as never);
}

function getPayload(id: string): {
  unreadInboxCount?: number;
  oldestUnreadDeliveredAt?: string;
} {
  const node = useCanvasStore.getState().nodes.find((n) => n.id === id);
  return (node?.data?.payload ?? {}) as {
    unreadInboxCount?: number;
    oldestUnreadDeliveredAt?: string;
  };
}

const baseHandoff = {
  toAgentId: 'programmer-1',
  timestamp: '2026-05-09T08:00:00Z'
};

const baseInboxRead = {
  readByAgentId: 'programmer-1',
  messageIds: [101]
};

describe('applyHandoffArrival / applyInboxRead (Issue #596 race fix)', () => {
  beforeEach(() => {
    useCanvasStore.setState({ nodes: [], edges: [], teamLocks: {} } as never);
  });

  afterEach(() => {
    useCanvasStore.setState({ nodes: [], edges: [], teamLocks: {} } as never);
  });

  it('handoff 1 件で unreadInboxCount=1 / oldest=evt.timestamp', () => {
    setStoreNodes([{ id: 'card-1', agentId: 'programmer-1', unreadInboxCount: 0 }]);
    const ok = applyHandoffArrival(useCanvasStore, 'card-1', baseHandoff, 'programmer-1');
    expect(ok).toBe(true);
    expect(getPayload('card-1')).toMatchObject({
      unreadInboxCount: 1,
      oldestUnreadDeliveredAt: '2026-05-09T08:00:00Z'
    });
  });

  it('1 frame 以内 handoff 連続 2 件で unreadInboxCount=2 になる (race fix)', () => {
    // 旧実装の bug: 同 tick 連続呼び出しで closure-captured payload (= 0) を読んでしまい
    //  両方が 0+1=1 を書いて最終 1 で止まる。新実装は store.getState() を毎回読むので 2 になる。
    setStoreNodes([{ id: 'card-1', agentId: 'programmer-1', unreadInboxCount: 0 }]);
    applyHandoffArrival(
      useCanvasStore,
      'card-1',
      { toAgentId: 'programmer-1', timestamp: '2026-05-09T08:00:00Z' },
      'programmer-1'
    );
    applyHandoffArrival(
      useCanvasStore,
      'card-1',
      { toAgentId: 'programmer-1', timestamp: '2026-05-09T08:00:00.010Z' },
      'programmer-1'
    );
    expect(getPayload('card-1')).toMatchObject({
      // 2 件分加算されている (= race 解消の核心)
      unreadInboxCount: 2,
      // oldest は最初に入った値を尊重 (新着で上書きしない)
      oldestUnreadDeliveredAt: '2026-05-09T08:00:00Z'
    });
  });

  it('handoff 5 連投でも unreadInboxCount=5 まで正しく加算される', () => {
    setStoreNodes([{ id: 'card-1', agentId: 'programmer-1', unreadInboxCount: 0 }]);
    for (let i = 0; i < 5; i++) {
      applyHandoffArrival(
        useCanvasStore,
        'card-1',
        {
          toAgentId: 'programmer-1',
          timestamp: `2026-05-09T08:00:00.${String(i).padStart(3, '0')}Z`
        },
        'programmer-1'
      );
    }
    expect(getPayload('card-1').unreadInboxCount).toBe(5);
    expect(getPayload('card-1').oldestUnreadDeliveredAt).toBe('2026-05-09T08:00:00.000Z');
  });

  it('toAgentId が自分以外なら更新されない', () => {
    setStoreNodes([{ id: 'card-1', agentId: 'programmer-1', unreadInboxCount: 3 }]);
    const ok = applyHandoffArrival(
      useCanvasStore,
      'card-1',
      { toAgentId: 'programmer-2', timestamp: '2026-05-09T08:00:00Z' },
      'programmer-1'
    );
    expect(ok).toBe(false);
    expect(getPayload('card-1').unreadInboxCount).toBe(3);
  });

  it('expectedAgentId 未設定 (Leader 等の identity 未確定) なら更新されない', () => {
    setStoreNodes([{ id: 'card-1', unreadInboxCount: 3 }]);
    const ok = applyHandoffArrival(
      useCanvasStore,
      'card-1',
      { toAgentId: 'programmer-1', timestamp: '2026-05-09T08:00:00Z' },
      undefined
    );
    expect(ok).toBe(false);
    expect(getPayload('card-1').unreadInboxCount).toBe(3);
  });

  it('inbox_read 1 件で unreadInboxCount を 1 件分減算する', () => {
    setStoreNodes([
      {
        id: 'card-1',
        agentId: 'programmer-1',
        unreadInboxCount: 3,
        oldestUnreadDeliveredAt: '2026-05-09T07:59:00Z'
      }
    ]);
    applyInboxRead(useCanvasStore, 'card-1', baseInboxRead, 'programmer-1');
    expect(getPayload('card-1')).toMatchObject({
      unreadInboxCount: 2,
      oldestUnreadDeliveredAt: '2026-05-09T07:59:00Z' // 部分既読では oldest を維持
    });
  });

  it('inbox_read で全件読了 (next=0) になると oldestUnreadDeliveredAt が undefined になる', () => {
    setStoreNodes([
      {
        id: 'card-1',
        agentId: 'programmer-1',
        unreadInboxCount: 2,
        oldestUnreadDeliveredAt: '2026-05-09T07:59:00Z'
      }
    ]);
    applyInboxRead(
      useCanvasStore,
      'card-1',
      { readByAgentId: 'programmer-1', messageIds: [101, 102] },
      'programmer-1'
    );
    expect(getPayload('card-1')).toMatchObject({
      unreadInboxCount: 0,
      oldestUnreadDeliveredAt: undefined
    });
  });

  it('1 frame 以内 inbox_read 連続 2 件 (1 件ずつ) でも race undercount せず 0 まで減る', () => {
    setStoreNodes([
      {
        id: 'card-1',
        agentId: 'programmer-1',
        unreadInboxCount: 2,
        oldestUnreadDeliveredAt: '2026-05-09T07:59:00Z'
      }
    ]);
    applyInboxRead(
      useCanvasStore,
      'card-1',
      { readByAgentId: 'programmer-1', messageIds: [101] },
      'programmer-1'
    );
    applyInboxRead(
      useCanvasStore,
      'card-1',
      { readByAgentId: 'programmer-1', messageIds: [102] },
      'programmer-1'
    );
    // 旧実装の bug: closure-captured 2 を 2 回読み、両方が 2-1=1 を書いて最終 1 で止まる。
    // 新実装は最新値 (1 回目後は 1) を base に -1 するので 0 になる。
    expect(getPayload('card-1').unreadInboxCount).toBe(0);
    expect(getPayload('card-1').oldestUnreadDeliveredAt).toBeUndefined();
  });

  it('inbox_read で count が負にならない (Math.max(0, ...))', () => {
    setStoreNodes([
      { id: 'card-1', agentId: 'programmer-1', unreadInboxCount: 1 }
    ]);
    applyInboxRead(
      useCanvasStore,
      'card-1',
      { readByAgentId: 'programmer-1', messageIds: [101, 102, 103] },
      'programmer-1'
    );
    expect(getPayload('card-1').unreadInboxCount).toBe(0);
  });

  it('inbox_read で readByAgentId が他人なら更新されない', () => {
    setStoreNodes([
      { id: 'card-1', agentId: 'programmer-1', unreadInboxCount: 3 }
    ]);
    const ok = applyInboxRead(
      useCanvasStore,
      'card-1',
      { readByAgentId: 'programmer-2', messageIds: [101] },
      'programmer-1'
    );
    expect(ok).toBe(false);
    expect(getPayload('card-1').unreadInboxCount).toBe(3);
  });

  it('handoff → inbox_read の交互連続でも store 最新値が常に base になる (mixed race)', () => {
    setStoreNodes([{ id: 'card-1', agentId: 'programmer-1', unreadInboxCount: 0 }]);
    // +1 +1 +1 -2 +1 → 2 になることを確認 (= 0+1=1, 1+1=2, 2+1=3, 3-2=1, 1+1=2)
    applyHandoffArrival(
      useCanvasStore,
      'card-1',
      { toAgentId: 'programmer-1', timestamp: '2026-05-09T08:00:00Z' },
      'programmer-1'
    );
    applyHandoffArrival(
      useCanvasStore,
      'card-1',
      { toAgentId: 'programmer-1', timestamp: '2026-05-09T08:00:01Z' },
      'programmer-1'
    );
    applyHandoffArrival(
      useCanvasStore,
      'card-1',
      { toAgentId: 'programmer-1', timestamp: '2026-05-09T08:00:02Z' },
      'programmer-1'
    );
    applyInboxRead(
      useCanvasStore,
      'card-1',
      { readByAgentId: 'programmer-1', messageIds: [101, 102] },
      'programmer-1'
    );
    applyHandoffArrival(
      useCanvasStore,
      'card-1',
      { toAgentId: 'programmer-1', timestamp: '2026-05-09T08:00:03Z' },
      'programmer-1'
    );
    expect(getPayload('card-1').unreadInboxCount).toBe(2);
  });
});

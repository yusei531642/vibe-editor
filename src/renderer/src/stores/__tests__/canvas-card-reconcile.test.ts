/**
 * Issue #938: addCard / addCards の agentId reconcile (upsert) と
 * PersistedCardNode 明示変換のテスト。
 *
 * 守りたい不変条件:
 *  - 同 type + 同 agentId のカードは何回 add しても 1 枚 (新規 spawn → registry の
 *    旧 PTY kill (#893) の事故経路を store レベルで遮断する)
 *  - reconcile 時は既存カードの position / size を保ち、payload は浅く merge される
 *  - agentId を持たないカードは従来どおり常に append
 *  - 永続化は PersistedCardNode への明示 pick で、dragging / selected / measured 等の
 *    React Flow ランタイムフィールドが localStorage に到達しない (#894/#895 の恒久化)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import { useCanvasStore, type CardData } from '../canvas';
import { toPersistedCardNode } from '../canvas-card-identity';

const TEAM = 'team-reconcile-test';

function agentSpec(agentId: string, overrides: Record<string, unknown> = {}) {
  return {
    type: 'agent' as const,
    title: `Agent ${agentId}`,
    position: { x: 0, y: 0 },
    payload: {
      agent: 'claude' as const,
      role: 'programmer',
      roleProfileId: 'programmer',
      teamId: TEAM,
      teamName: 'Reconcile Test',
      agentId,
      cwd: 'C:/proj',
      ...overrides
    }
  };
}

describe('useCanvasStore reconcile (Issue #938)', () => {
  beforeEach(() => {
    if (typeof localStorage !== 'undefined') localStorage.clear();
    useCanvasStore.getState().clear();
  });

  it('同 agentId の addCards 再実行でカードが複製されない (resume 経路の #893 再生産防止)', () => {
    const store = useCanvasStore.getState();
    const first = store.addCards([agentSpec('programmer-0-' + TEAM)]);
    expect(useCanvasStore.getState().nodes).toHaveLength(1);

    // 稼働中チームを resume したのと同じ: 同一 agentId の spec をもう一度 addCards
    const second = useCanvasStore
      .getState()
      .addCards([agentSpec('programmer-0-' + TEAM, { resumeSessionId: 'session-12345678' })]);

    const nodes = useCanvasStore.getState().nodes;
    expect(nodes).toHaveLength(1);
    // 既存カードの id がそのまま返る (viewport フォーカス等の caller が既存カードを掴める)
    expect(second[0]).toBe(first[0]);
  });

  it('reconcile は payload を浅く merge し position は既存値を保つ', () => {
    const store = useCanvasStore.getState();
    const [id] = store.addCards([agentSpec('researcher-1-' + TEAM)]);
    // ユーザーがカードを動かした状態を再現
    useCanvasStore.setState({
      nodes: useCanvasStore
        .getState()
        .nodes.map((n) => (n.id === id ? { ...n, position: { x: 1234, y: 567 } } : n))
    });

    useCanvasStore
      .getState()
      .addCards([agentSpec('researcher-1-' + TEAM, { resumeSessionId: 'session-abcdefgh' })]);

    const node = useCanvasStore.getState().nodes.find((n) => n.id === id);
    expect(node?.position).toEqual({ x: 1234, y: 567 });
    const payload = node?.data.payload as Record<string, unknown>;
    expect(payload.resumeSessionId).toBe('session-abcdefgh');
    expect(payload.cwd).toBe('C:/proj'); // 既存キーは保持
  });

  it('同一バッチ内の重複 agentId も 1 枚に畳まれる', () => {
    const ids = useCanvasStore
      .getState()
      .addCards([agentSpec('reviewer-2-' + TEAM), agentSpec('reviewer-2-' + TEAM)]);
    expect(useCanvasStore.getState().nodes).toHaveLength(1);
    expect(ids[0]).toBe(ids[1]);
  });

  it('addCard (単数) も同 agentId の terminal カードを reconcile する', () => {
    const store = useCanvasStore.getState();
    const first = store.addCard({
      type: 'terminal',
      title: 'T1',
      payload: { agentId: 'solo-agent-1', cwd: 'C:/proj' }
    });
    const second = useCanvasStore.getState().addCard({
      type: 'terminal',
      title: 'T1 (resumed)',
      payload: { agentId: 'solo-agent-1', resumeSessionId: 'session-87654321' }
    });
    expect(second).toBe(first);
    expect(useCanvasStore.getState().nodes).toHaveLength(1);
  });

  it('agentId を持たないカードは従来どおり append される', () => {
    const store = useCanvasStore.getState();
    store.addCard({ type: 'editor', title: 'a.ts', payload: { projectRoot: 'C:/p', relPath: 'a.ts' } });
    useCanvasStore
      .getState()
      .addCard({ type: 'editor', title: 'a.ts', payload: { projectRoot: 'C:/p', relPath: 'a.ts' } });
    expect(useCanvasStore.getState().nodes).toHaveLength(2);
  });

  it('type が異なれば同じ agentId でも reconcile しない', () => {
    const store = useCanvasStore.getState();
    store.addCard({ type: 'terminal', title: 'T', payload: { agentId: 'x-agent-1' } });
    useCanvasStore.getState().addCards([agentSpec('x-agent-1')]);
    expect(useCanvasStore.getState().nodes).toHaveLength(2);
  });
});

describe('toPersistedCardNode (Issue #938)', () => {
  it('ランタイムフィールド (dragging / selected / measured) は永続化スキーマに含まれない', () => {
    const node = {
      id: 'agent-1',
      type: 'agent',
      position: { x: 10, y: 20 },
      data: { cardType: 'agent', title: 'A', payload: { agentId: 'a-1' } },
      style: { width: 760, height: 460 },
      dragging: true,
      selected: true,
      resizing: true,
      measured: { width: 999, height: 999 },
      zIndex: 5
    } as unknown as Node<CardData>;

    const persisted = toPersistedCardNode(node);
    expect(persisted).toEqual({
      id: 'agent-1',
      type: 'agent',
      position: { x: 10, y: 20 },
      data: { cardType: 'agent', title: 'A', payload: { agentId: 'a-1' } },
      style: { width: 760, height: 460 }
    });
    expect('dragging' in persisted).toBe(false);
    expect('measured' in persisted).toBe(false);
  });

  it('NodeResizer の手動リサイズ値 (top-level width/height) は意図的に永続化される', () => {
    const node = {
      id: 'terminal-1',
      type: 'terminal',
      position: { x: 0, y: 0 },
      data: { cardType: 'terminal', title: 'T', payload: undefined },
      style: { width: 760, height: 460 },
      width: 900,
      height: 600
    } as unknown as Node<CardData>;

    const persisted = toPersistedCardNode(node);
    expect(persisted.width).toBe(900);
    expect(persisted.height).toBe(600);
  });
});

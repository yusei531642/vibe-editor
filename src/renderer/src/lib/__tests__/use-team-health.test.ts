import { describe, expect, it } from 'vitest';
import type { TeamDiagnosticsMemberRow } from '../../../../types/shared';
import { __teamHealthTest } from '../use-team-health';

function row(overrides: Partial<TeamDiagnosticsMemberRow> = {}): TeamDiagnosticsMemberRow {
  return {
    agentId: 'worker-1',
    role: 'programmer',
    online: true,
    inconsistent: false,
    recruitedAt: '2026-05-16T00:00:00Z',
    lastHandshakeAt: null,
    lastSeenAt: null,
    lastAgentActivityAt: null,
    lastMessageInAt: null,
    lastMessageOutAt: null,
    messagesInCount: 0,
    messagesOutCount: 0,
    tasksClaimedCount: 0,
    pendingInbox: [],
    pendingInboxCount: 0,
    oldestPendingInboxAgeMs: null,
    stalledInbound: false,
    currentStatus: null,
    lastStatusAt: null,
    lastPtyOutputAt: null,
    lastStatusAgeMs: null,
    lastPtyActivityAgeMs: null,
    autoStale: false,
    stalenessThresholdMs: 300_000,
    ...overrides
  };
}

describe('team health snapshot signature', () => {
  it('ignores server-computed age fields that change on every poll', () => {
    const first = __teamHealthTest.snapshotSignature({
      'worker-1': row({
        lastStatusAgeMs: 5_000,
        lastPtyActivityAgeMs: 10_000,
        oldestPendingInboxAgeMs: 15_000
      })
    });
    const second = __teamHealthTest.snapshotSignature({
      'worker-1': row({
        lastStatusAgeMs: 10_000,
        lastPtyActivityAgeMs: 15_000,
        oldestPendingInboxAgeMs: 20_000
      })
    });

    expect(second).toBe(first);
  });

  it('changes when stable diagnostics fields change', () => {
    const first = __teamHealthTest.snapshotSignature({
      'worker-1': row({ currentStatus: 'building' })
    });
    const second = __teamHealthTest.snapshotSignature({
      'worker-1': row({ currentStatus: 'testing' })
    });

    expect(second).not.toBe(first);
  });

  it('is stable regardless of agent object insertion order', () => {
    const first = __teamHealthTest.snapshotSignature({
      'worker-2': row({ agentId: 'worker-2' }),
      'worker-1': row({ agentId: 'worker-1' })
    });
    const second = __teamHealthTest.snapshotSignature({
      'worker-1': row({ agentId: 'worker-1' }),
      'worker-2': row({ agentId: 'worker-2' })
    });

    expect(second).toBe(first);
  });
});

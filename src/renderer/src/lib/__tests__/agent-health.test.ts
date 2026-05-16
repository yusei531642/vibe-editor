import { describe, expect, it } from 'vitest';
import type { TeamDiagnosticsMemberRow } from '../../../../types/shared';
import { deriveHealth } from '../agent-health';

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

describe('deriveHealth', () => {
  it('passes through pending inbox diagnostics for unread badge rendering', () => {
    const health = deriveHealth(
      row({
        pendingInbox: [101, 102],
        pendingInboxCount: 2,
        oldestPendingInboxAgeMs: 65_000,
        stalledInbound: true
      })
    );

    expect(health.pendingInboxCount).toBe(2);
    expect(health.oldestPendingInboxAgeMs).toBe(65_000);
    expect(health.stalledInbound).toBe(true);
  });

  it('uses clean pending inbox defaults when diagnostics are unavailable', () => {
    const health = deriveHealth(null);

    expect(health.pendingInboxCount).toBe(0);
    expect(health.oldestPendingInboxAgeMs).toBeNull();
    expect(health.stalledInbound).toBe(false);
  });
});

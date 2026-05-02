import { describe, expect, it } from 'vitest';
import {
  mergeCanvasMembers,
  serializeAutoSavePayload
} from '../canvas-layout-helpers';
import type { TeamHistoryEntry } from '../../../../types/shared';

function entryWithSession(sessionId: string | null): TeamHistoryEntry {
  return {
    id: 'team-1',
    name: 'Team',
    projectRoot: 'F:\\vive-editor',
    createdAt: '2026-05-03T00:00:00.000Z',
    lastUsedAt: '2026-05-03T00:00:00.000Z',
    members: [{ role: 'leader', agent: 'claude', sessionId }]
  };
}

describe('canvas-layout-helpers', () => {
  it('Canvas payload の新しい sessionId を Team 履歴メンバーへ反映する', () => {
    const members = mergeCanvasMembers(
      [{ role: 'leader', agent: 'claude', sessionId: 'new-session' }],
      entryWithSession('old-session')
    );

    expect(members).toEqual([
      { role: 'leader', agent: 'claude', sessionId: 'new-session' }
    ]);
  });

  it('Canvas payload に sessionId が無いときは既存履歴の sessionId を保持する', () => {
    const members = mergeCanvasMembers(
      [{ role: 'leader', agent: 'claude', sessionId: null }],
      entryWithSession('old-session')
    );

    expect(members).toEqual([
      { role: 'leader', agent: 'claude', sessionId: 'old-session' }
    ]);
  });

  it('sessionId の変更だけでも auto-save key が変わる', () => {
    const makeKey = (sessionId: string | null): string =>
      serializeAutoSavePayload({
        byTeam: new Map([
          [
            'team-1',
            {
              name: 'Team',
              members: [{ role: 'leader', agent: 'claude', sessionId }],
              canvasNodes: [{ agentId: 'leader-0-team-1', x: 0, y: 0 }]
            }
          ]
        ]),
        viewport: { x: 0, y: 0, zoom: 1 }
      });

    expect(makeKey('session-a')).not.toBe(makeKey('session-b'));
  });
});

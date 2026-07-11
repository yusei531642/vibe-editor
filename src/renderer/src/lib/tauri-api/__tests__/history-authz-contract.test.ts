import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo, TeamHistoryEntry } from '../../../../../types/shared';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke
}));

import { CommandError } from '../command-error';
import { sessions } from '../sessions';
import { teamHistory } from '../team-history';

const sessionResponse = [
  {
    id: 'session-1',
    path: '/home/test/.claude/projects/active/session-1.jsonl',
    title: 'active session',
    messageCount: 2,
    messageCountCapped: false,
    lastModifiedAt: '2026-07-11T00:00:00Z',
    lastModifiedMs: 1
  }
] satisfies SessionInfo[];

const historyResponse = [
  {
    id: 'team-1',
    name: 'Active team',
    projectRoot: '/workspace/active',
    createdAt: '2026-07-11T00:00:00Z',
    lastUsedAt: '2026-07-11T00:00:00Z',
    members: []
  }
] satisfies TeamHistoryEntry[];

describe('sessions/teamHistory list authz IPC contract', () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
  });

  it('preserves success arrays and the existing projectRoot invoke shape', async () => {
    mocks.invoke.mockResolvedValueOnce(sessionResponse);
    await expect(sessions.list('/workspace/active')).resolves.toBe(sessionResponse);
    expect(mocks.invoke).toHaveBeenLastCalledWith('sessions_list', {
      projectRoot: '/workspace/active'
    });

    mocks.invoke.mockResolvedValueOnce(historyResponse);
    await expect(teamHistory.list('/workspace/active')).resolves.toBe(historyResponse);
    expect(mocks.invoke).toHaveBeenLastCalledWith('team_history_list', {
      projectRoot: '/workspace/active'
    });
  });

  it.each([
    ['sessions_list', () => sessions.list('/workspace/foreign')],
    ['team_history_list', () => teamHistory.list('/workspace/foreign')]
  ])('normalizes %s authz rejection as CommandError', async (command, list) => {
    mocks.invoke.mockRejectedValueOnce({
      code: 'authz',
      message: 'project_root does not match active project'
    });

    await expect(list()).rejects.toMatchObject<Partial<CommandError>>({
      name: 'CommandError',
      command,
      code: 'authz',
      message: 'project_root does not match active project'
    });
  });
});

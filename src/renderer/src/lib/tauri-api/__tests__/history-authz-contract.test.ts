import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo, TeamHistoryEntry } from '../../../../../types/shared';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke
}));

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

    await expect(list()).rejects.toMatchObject({
      name: 'CommandError',
      command,
      code: 'authz',
      message: 'project_root does not match active project'
    });
  });

  it('normalizes a no-active-project rejection for history callers to handle', async () => {
    mocks.invoke.mockRejectedValueOnce({
      code: 'authz',
      message: 'no active project root'
    });

    await expect(teamHistory.list('/workspace/initializing')).rejects.toMatchObject({
      name: 'CommandError',
      command: 'team_history_list',
      code: 'authz',
      message: 'no active project root'
    });
  });
});

describe('teamHistory mutation authz IPC contract (Issue #1194)', () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
  });

  const activeEntry = historyResponse[0];

  it('sends projectRoot with delete and resolves the MutationResult', async () => {
    mocks.invoke.mockResolvedValueOnce({ ok: true });
    await expect(teamHistory.delete('/workspace/active', 'team-1')).resolves.toEqual({
      ok: true
    });
    expect(mocks.invoke).toHaveBeenLastCalledWith('team_history_delete', {
      projectRoot: '/workspace/active',
      id: 'team-1'
    });
  });

  it.each([
    ['team_history_save', () => teamHistory.save(activeEntry)],
    ['team_history_save_batch', () => teamHistory.saveBatch([activeEntry])],
    ['team_history_delete', () => teamHistory.delete('/workspace/foreign', 'team-1')]
  ])('maps %s authz rejection to a failed MutationResult with code', async (_command, run) => {
    mocks.invoke.mockRejectedValueOnce({
      code: 'authz',
      message: 'entry project_root must match the active project root notation'
    });

    await expect(run()).resolves.toEqual({
      ok: false,
      code: 'authz',
      error: 'entry project_root must match the active project root notation'
    });
  });

  it('maps non-structured mutation failures without a code', async () => {
    mocks.invoke.mockRejectedValueOnce('disk exploded');
    await expect(teamHistory.save(activeEntry)).resolves.toEqual({
      ok: false,
      error: 'disk exploded'
    });
  });
});

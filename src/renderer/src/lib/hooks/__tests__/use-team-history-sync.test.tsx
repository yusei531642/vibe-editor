import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mcpAutoSetup: false
}));

vi.mock('../../i18n', () => ({
  useT: () => (key: string) => key
}));

vi.mock('../../settings-context', () => ({
  useSettingsValue: () => mocks.mcpAutoSetup
}));

import {
  useTeamHistorySync,
  type UseTeamHistorySyncOptions
} from '../use-team-history-sync';
import type { TeamHistoryEntry } from '../../../../../types/shared';

type MockApi = {
  teamHistory: {
    list: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
};

type TestWindow = Window &
  typeof globalThis & {
    api?: MockApi;
  };

function installApi(): MockApi {
  const api: MockApi = {
    teamHistory: {
      list: vi.fn(async () => []),
      save: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined)
    }
  };
  (window as TestWindow).api = api;
  return api;
}

function options(
  overrides: Partial<UseTeamHistorySyncOptions> = {}
): UseTeamHistorySyncOptions {
  return {
    projectRoot: '/workspace/active',
    showToast: vi.fn(),
    terminalTabs: [],
    setTerminalTabs: vi.fn(),
    addTerminalTab: vi.fn(() => null),
    teams: [],
    setTeams: vi.fn(),
    clearSpawnTimers: vi.fn(),
    ...overrides
  };
}

function teamEntry(): TeamHistoryEntry {
  return {
    id: 'team-1',
    name: 'Test Team',
    projectRoot: '/workspace/active',
    createdAt: '2026-07-14T00:00:00.000Z',
    lastUsedAt: '2026-07-14T00:00:00.000Z',
    members: [
      {
        role: 'leader',
        agent: 'claude',
        agentId: 'leader-1',
        sessionId: 'session-1'
      }
    ]
  };
}

describe('useTeamHistorySync', () => {
  let originalApi: MockApi | undefined;

  beforeEach(() => {
    originalApi = (window as TestWindow).api;
    mocks.mcpAutoSetup = false;
  });

  afterEach(() => {
    cleanup();
    if (originalApi === undefined) {
      delete (window as TestWindow).api;
    } else {
      (window as TestWindow).api = originalApi;
    }
    vi.restoreAllMocks();
  });

  it('absorbs a no-active-project history rejection during the initial refresh', async () => {
    const api = installApi();
    const authzError = Object.assign(new Error('no active project root'), {
      code: 'authz'
    });
    api.teamHistory.list.mockRejectedValueOnce(authzError);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const { result } = renderHook(() => useTeamHistorySync(options()));

    await waitFor(() => {
      expect(api.teamHistory.list).toHaveBeenCalledWith('/workspace/active');
      expect(warn).toHaveBeenCalledWith('[teamHistory] list failed:', authzError);
    });
    expect(result.current.teamHistoryEntries).toEqual([]);
  });

  it('does not resume a team that already has an IDE terminal tab (#1138)', async () => {
    installApi();
    const addTerminalTab = vi.fn(() => 2);
    const showToast = vi.fn();
    const existingTab = {
      teamId: 'team-1'
    } as UseTeamHistorySyncOptions['terminalTabs'][number];
    const { result } = renderHook(() =>
      useTeamHistorySync(options({ terminalTabs: [existingTab], addTerminalTab, showToast }))
    );

    await act(async () => result.current.handleResumeTeam(teamEntry()));

    expect(addTerminalTab).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('teamHistory.alreadyOpen', { tone: 'info' });
  });

  it('reserves the team id so rapid resume clicks spawn members only once (#1138)', async () => {
    installApi();
    const addTerminalTab = vi.fn(() => 1);
    const showToast = vi.fn();
    const { result } = renderHook(() =>
      useTeamHistorySync(options({ addTerminalTab, showToast }))
    );
    const entry = teamEntry();

    await act(async () => {
      await Promise.all([
        result.current.handleResumeTeam(entry),
        result.current.handleResumeTeam(entry)
      ]);
    });

    expect(addTerminalTab).toHaveBeenCalledTimes(entry.members.length);
    expect(showToast).toHaveBeenCalledWith('teamHistory.alreadyOpen', { tone: 'info' });
  });
});

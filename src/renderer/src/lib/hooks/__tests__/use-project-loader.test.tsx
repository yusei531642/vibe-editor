import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../../../../types/shared';

const mocks = vi.hoisted(() => ({
  settingsLoading: false,
  settingsValues: {
    claudeCwd: '',
    lastOpenedRoot: '',
    recentProjects: [] as string[],
    hasCompletedOnboarding: true,
    mcpAutoSetup: false,
    workspaceFolders: [] as string[]
  },
  updateSettings: vi.fn(async () => undefined),
  confirm: vi.fn(async () => true),
  setStatus: vi.fn()
}));

vi.mock('../../settings-context', () => ({
  useSettingsActions: () => ({ update: mocks.updateSettings }),
  useSettingsLoading: () => mocks.settingsLoading,
  useSettingsValue: (key: keyof AppSettings) =>
    mocks.settingsValues[key as keyof typeof mocks.settingsValues]
}));

vi.mock('../../i18n', () => ({
  useT: () => (key: string, params?: Record<string, string | number>) =>
    params?.error ? `${key}: ${params.error}` : key
}));

vi.mock('../../use-native-confirm', () => ({
  useNativeConfirm: () => mocks.confirm
}));

vi.mock('../../../stores/ui', () => ({
  useUiStore: {
    getState: () => ({ setStatus: mocks.setStatus })
  }
}));

import {
  useProjectLoader,
  type UseProjectLoaderOptions
} from '../use-project-loader';

type TestWindow = Window &
  typeof globalThis & {
    api?: MockApi;
  };

interface MockApi {
  app: {
    restoreAuthorizedProjectRoot: ReturnType<typeof vi.fn>;
    pickAndActivateProjectRoot: ReturnType<typeof vi.fn>;
    reconfirmProjectRoot: ReturnType<typeof vi.fn>;
    pickFileAndActivateProjectRoot: ReturnType<typeof vi.fn>;
    clearActiveProjectRoot: ReturnType<typeof vi.fn>;
    pickWorkspaceRoot: ReturnType<typeof vi.fn>;
    revokeWorkspaceRoot: ReturnType<typeof vi.fn>;
    setupTeamMcp: ReturnType<typeof vi.fn>;
    setWindowTitle: ReturnType<typeof vi.fn>;
  };
  dialog: {
    openFolder: ReturnType<typeof vi.fn>;
    openFile: ReturnType<typeof vi.fn>;
    isFolderEmpty: ReturnType<typeof vi.fn>;
  };
  git: {
    status: ReturnType<typeof vi.fn>;
  };
  sessions: {
    list: ReturnType<typeof vi.fn>;
  };
}

function installApi(): MockApi {
  const api: MockApi = {
    app: {
      restoreAuthorizedProjectRoot: vi.fn(async () => ''),
      pickAndActivateProjectRoot: vi.fn(async () => null),
      reconfirmProjectRoot: vi.fn(async () => null),
      pickFileAndActivateProjectRoot: vi.fn(async () => null),
      clearActiveProjectRoot: vi.fn(async () => undefined),
      pickWorkspaceRoot: vi.fn(async () => null),
      revokeWorkspaceRoot: vi.fn(async () => undefined),
      setupTeamMcp: vi.fn(async () => undefined),
      setWindowTitle: vi.fn(async () => undefined)
    },
    dialog: {
      openFolder: vi.fn(async () => ''),
      openFile: vi.fn(async () => ''),
      isFolderEmpty: vi.fn(async () => true)
    },
    git: {
      status: vi.fn(async () => ({ ok: true, files: [] }))
    },
    sessions: {
      list: vi.fn(async () => [])
    }
  };
  (window as TestWindow).api = api;
  return api;
}

function options(overrides: Partial<UseProjectLoaderOptions> = {}): UseProjectLoaderOptions {
  return {
    confirmDiscardEditorTabs: vi.fn(async () => true),
    onProjectSwitched: vi.fn(),
    onLoaded: vi.fn(),
    showToast: vi.fn(),
    discardEditorTabsForRoot: vi.fn(async () => true),
    ...overrides
  };
}

describe('useProjectLoader', () => {
  let originalApi: MockApi | undefined;

  beforeEach(() => {
    originalApi = (window as TestWindow).api;
    mocks.settingsLoading = false;
    mocks.settingsValues.claudeCwd = '';
    mocks.settingsValues.lastOpenedRoot = '';
    mocks.settingsValues.recentProjects = [];
    mocks.settingsValues.hasCompletedOnboarding = true;
    mocks.settingsValues.mcpAutoSetup = false;
    mocks.settingsValues.workspaceFolders = [];
    mocks.updateSettings.mockClear();
    mocks.confirm.mockClear();
    mocks.setStatus.mockClear();
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

  it('保存済み root はauthorityに使わず、native pickerの結果だけを起動する', async () => {
    const invalidRoot = 'C:\\Users\\zooyo';
    const pickedRoot =
      'C:\\Users\\zooyo\\Documents\\GitHub\\DX\\digital-management-consulting-app';
    mocks.settingsValues.lastOpenedRoot = invalidRoot;
    mocks.settingsValues.claudeCwd = invalidRoot;
    const api = installApi();
    api.app.pickAndActivateProjectRoot.mockResolvedValueOnce(pickedRoot);
    const onLoaded = vi.fn();
    const onProjectSwitched = vi.fn();

    const { result } = renderHook(() =>
      useProjectLoader(options({ onLoaded, onProjectSwitched }))
    );

    await waitFor(() => expect(api.app.pickAndActivateProjectRoot).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.git.status).toHaveBeenCalledWith(pickedRoot));

    expect(api.app.restoreAuthorizedProjectRoot).toHaveBeenCalledTimes(1);
    expect(api.app.pickAndActivateProjectRoot).toHaveBeenCalledWith('appMenu.openFolderDialogTitle');
    expect(mocks.updateSettings).toHaveBeenCalledWith({ lastOpenedRoot: pickedRoot });
    expect(result.current.projectRoot).toBe(pickedRoot);
    expect(onLoaded).toHaveBeenCalledWith({
      gitStatus: { ok: true, files: [] },
      sessions: []
    });
    expect(onProjectSwitched).not.toHaveBeenCalled();
  });

  it('recent pathはnative pickerの初期位置にだけ渡し、再選択結果をloadする', async () => {
    const api = installApi();
    api.app.restoreAuthorizedProjectRoot.mockResolvedValueOnce('/repo');
    api.app.reconfirmProjectRoot.mockResolvedValueOnce('/repo-next');
    const { result } = renderHook(() => useProjectLoader(options()));
    await waitFor(() => expect(result.current.projectRoot).toBe('/repo'));

    await act(async () => {
      await result.current.handleOpenRecent('/history-only');
    });

    expect(api.app.reconfirmProjectRoot).toHaveBeenCalledWith(
      '/history-only',
      'project.openExistingDialogTitle'
    );
    expect(api.git.status).toHaveBeenLastCalledWith('/repo-next');
    expect(result.current.projectRoot).toBe('/repo-next');
  });
});

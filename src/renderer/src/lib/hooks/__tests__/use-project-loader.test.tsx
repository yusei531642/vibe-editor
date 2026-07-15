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
  Object.defineProperty(window, 'api', { configurable: true, writable: true, value: api });
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
  let originalApi: Window['api'] | undefined;

  beforeEach(() => {
    originalApi = window.api;
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
      Reflect.deleteProperty(window, 'api');
    } else {
      Object.defineProperty(window, 'api', { configurable: true, writable: true, value: originalApi });
    }
    vi.restoreAllMocks();
  });

  it('保存済み root はauthorityに使わず、native reconfirmの結果だけを起動する', async () => {
    const invalidRoot = 'C:\\Users\\zooyo';
    const pickedRoot =
      'C:\\Users\\zooyo\\Documents\\GitHub\\DX\\digital-management-consulting-app';
    mocks.settingsValues.lastOpenedRoot = invalidRoot;
    mocks.settingsValues.claudeCwd = invalidRoot;
    const api = installApi();
    api.app.reconfirmProjectRoot.mockResolvedValueOnce(pickedRoot);
    const onLoaded = vi.fn();
    const onProjectSwitched = vi.fn();

    const { result } = renderHook(() =>
      useProjectLoader(options({ onLoaded, onProjectSwitched }))
    );

    await waitFor(() => expect(api.app.reconfirmProjectRoot).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.git.status).toHaveBeenCalledWith(pickedRoot));

    expect(api.app.restoreAuthorizedProjectRoot).toHaveBeenCalledTimes(1);
    expect(api.app.reconfirmProjectRoot).toHaveBeenCalledWith(
      invalidRoot,
      'appMenu.openFolderDialogTitle'
    );
    expect(api.app.pickAndActivateProjectRoot).not.toHaveBeenCalled();
    expect(mocks.updateSettings).toHaveBeenCalledWith({ lastOpenedRoot: pickedRoot });
    expect(result.current.projectRoot).toBe(pickedRoot);
    expect(onLoaded).toHaveBeenCalledWith({
      gitStatus: { ok: true, files: [] },
      sessions: []
    });
    expect(onProjectSwitched).not.toHaveBeenCalled();
  });

  it('初期IPC失敗時もnative authorityと選択rootを保持する', async () => {
    const api = installApi();
    api.app.restoreAuthorizedProjectRoot.mockResolvedValueOnce('/repo');
    api.git.status.mockRejectedValueOnce(new Error('transient git failure'));
    const onProjectSwitched = vi.fn();

    const { result } = renderHook(() =>
      useProjectLoader(options({ onProjectSwitched }))
    );

    await waitFor(() => expect(result.current.gitLoading).toBe(false));

    expect(result.current.projectRoot).toBe('/repo');
    expect(api.app.clearActiveProjectRoot).not.toHaveBeenCalled();
    expect(onProjectSwitched).not.toHaveBeenCalled();
    expect(mocks.setStatus).toHaveBeenLastCalledWith(
      'project.initError: Error: transient git failure'
    );
  });

  it('native reconfirm失敗時はsettingsのrootを採用しない', async () => {
    const untrustedRoot = 'C:\\Users\\zooyo\\Documents\\untrusted';
    mocks.settingsValues.lastOpenedRoot = untrustedRoot;
    const api = installApi();
    api.app.reconfirmProjectRoot.mockRejectedValueOnce(new Error('reconfirm failed'));

    const { result } = renderHook(() => useProjectLoader(options()));

    await waitFor(() => expect(result.current.gitLoading).toBe(false));

    expect(api.app.reconfirmProjectRoot).toHaveBeenCalledWith(
      untrustedRoot,
      'appMenu.openFolderDialogTitle'
    );
    expect(result.current.projectRoot).toBe('');
    expect(api.git.status).not.toHaveBeenCalled();
    expect(api.app.clearActiveProjectRoot).not.toHaveBeenCalled();
    expect(mocks.setStatus).toHaveBeenLastCalledWith(
      'project.initError: Error: reconfirm failed'
    );
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

  it('refreshGitのIPC失敗を処理してerror toastを表示する (#1139)', async () => {
    const api = installApi();
    api.app.restoreAuthorizedProjectRoot.mockResolvedValueOnce('/repo');
    const showToast = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { result } = renderHook(() => useProjectLoader(options({ showToast })));
    await waitFor(() => expect(result.current.projectRoot).toBe('/repo'));
    const error = new Error('git IPC failed');
    api.git.status.mockRejectedValueOnce(error);

    await act(async () => result.current.refreshGit());

    expect(warn).toHaveBeenCalledWith('[refresh] git.status failed:', error);
    expect(showToast).toHaveBeenCalledWith('toast.gitRefreshFailed', { tone: 'error' });
    expect(result.current.gitLoading).toBe(false);
  });
});

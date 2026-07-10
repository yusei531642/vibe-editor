import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileReadResult } from '../../../../../types/shared';
import { useFileTabs, type UseFileTabsOptions } from '../use-file-tabs';

vi.mock('../../i18n', () => ({
  useT: () => (key: string) => key
}));

vi.mock('../../use-native-confirm', () => ({
  useNativeConfirm: () => vi.fn(async () => true)
}));

type TestWindow = Window &
  typeof globalThis & {
    api?: MockApi;
  };

interface MockApi {
  files: {
    read: ReturnType<typeof vi.fn>;
  };
}

function fileReadResult(path: string, content: string): FileReadResult {
  return {
    ok: true,
    path,
    content,
    isBinary: false,
    encoding: 'utf-8',
    mtimeMs: 1,
    sizeBytes: content.length,
    contentHash: `hash:${content}`
  };
}

function installApi(): MockApi {
  const api: MockApi = {
    files: {
      read: vi.fn(async (_rootPath: string, relPath: string) =>
        fileReadResult(relPath, 'disk content')
      )
    }
  };
  (window as TestWindow).api = api;
  return api;
}

function options(overrides: Partial<UseFileTabsOptions> = {}): UseFileTabsOptions {
  return {
    projectRoot: '/workspace/a',
    refreshGit: vi.fn(async () => undefined),
    gitStatus: null,
    showToast: vi.fn(),
    ...overrides
  };
}

describe('useFileTabs.openEditorTab', () => {
  let originalApi: MockApi | undefined;

  beforeEach(() => {
    originalApi = (window as TestWindow).api;
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

  it('新規ファイルを1回だけ読み込んでタブを作成する', async () => {
    const api = installApi();
    const { result } = renderHook(() => useFileTabs(options()));

    await act(async () => {
      await result.current.openEditorTab('/workspace/a', 'src/file.ts');
    });

    expect(api.files.read).toHaveBeenCalledTimes(1);
    expect(api.files.read).toHaveBeenCalledWith('/workspace/a', 'src/file.ts');
    expect(result.current.editorTabs).toHaveLength(1);
    expect(result.current.editorTabs[0]).toMatchObject({
      rootPath: '/workspace/a',
      relPath: 'src/file.ts',
      content: 'disk content',
      originalContent: 'disk content',
      loading: false
    });
  });

  it('dirtyな既存タブの再選択では再読込せず編集内容を保持する', async () => {
    const api = installApi();
    const { result } = renderHook(() => useFileTabs(options()));

    await act(async () => {
      await result.current.openEditorTab('/workspace/a', 'src/file.ts');
    });

    const tabId = result.current.editorTabs[0]!.id;
    act(() => {
      result.current.updateEditorContent(tabId, 'unsaved edit');
    });
    api.files.read.mockResolvedValueOnce(
      fileReadResult('src/file.ts', 'changed disk content')
    );

    await act(async () => {
      await result.current.openEditorTab('/workspace/a', 'src/file.ts');
    });

    expect(api.files.read).toHaveBeenCalledTimes(1);
    expect(result.current.activeTabId).toBe(tabId);
    expect(result.current.editorTabs[0]).toMatchObject({
      content: 'unsaved edit',
      originalContent: 'disk content'
    });
    expect(result.current.dirtyEditorTabs.map((tab) => tab.id)).toEqual([tabId]);
    expect(result.current.recentFiles).toEqual([
      { rootPath: '/workspace/a', relPath: 'src/file.ts' }
    ]);
  });

  it('別rootの同一relPathは別タブとしてそれぞれ読み込む', async () => {
    const api = installApi();
    const { result } = renderHook(() => useFileTabs(options()));

    await act(async () => {
      await result.current.openEditorTab('/workspace/a', 'src/file.ts');
      await result.current.openEditorTab('/workspace/b', 'src/file.ts');
    });

    expect(api.files.read).toHaveBeenCalledTimes(2);
    expect(api.files.read).toHaveBeenNthCalledWith(1, '/workspace/a', 'src/file.ts');
    expect(api.files.read).toHaveBeenNthCalledWith(2, '/workspace/b', 'src/file.ts');
    expect(result.current.editorTabs.map((tab) => tab.rootPath)).toEqual([
      '/workspace/a',
      '/workspace/b'
    ]);
    expect(result.current.editorTabs[0]!.id).not.toBe(result.current.editorTabs[1]!.id);
  });
});

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
    write: ReturnType<typeof vi.fn>;
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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

function fileReadError(path: string, error: string): FileReadResult {
  return {
    ...fileReadResult(path, ''),
    ok: false,
    error
  };
}

function installApi(): MockApi {
  const api: MockApi = {
    files: {
      read: vi.fn(async (_rootPath: string, relPath: string) =>
        fileReadResult(relPath, 'disk content')
      ),
      write: vi.fn(async (_rootPath: string, _relPath: string, content: string) => ({
        ok: true,
        mtimeMs: 2,
        sizeBytes: content.length,
        contentHash: `saved:${content}`
      }))
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

  it('別タブからdirtyな既存タブを再選択するとactive化してrecent先頭へ移し、編集内容を保持する', async () => {
    const api = installApi();
    const { result } = renderHook(() => useFileTabs(options()));

    await act(async () => {
      await result.current.openEditorTab('/workspace/a', 'src/file.ts');
      await result.current.openEditorTab('/workspace/a', 'src/other.ts');
    });

    const tabId = result.current.editorTabs.find((tab) => tab.relPath === 'src/file.ts')!.id;
    act(() => {
      result.current.updateEditorContent(tabId, 'unsaved edit');
    });
    api.files.read.mockResolvedValueOnce(
      fileReadResult('src/file.ts', 'changed disk content')
    );

    await act(async () => {
      await result.current.openEditorTab('/workspace/a', 'src/file.ts');
    });

    expect(api.files.read).toHaveBeenCalledTimes(2);
    expect(result.current.activeTabId).toBe(tabId);
    expect(result.current.editorTabs.find((tab) => tab.id === tabId)).toMatchObject({
      content: 'unsaved edit',
      originalContent: 'disk content'
    });
    expect(result.current.dirtyEditorTabs.map((tab) => tab.id)).toEqual([tabId]);
    expect(result.current.recentFiles).toEqual([
      { rootPath: '/workspace/a', relPath: 'src/file.ts' },
      { rootPath: '/workspace/a', relPath: 'src/other.ts' }
    ]);
  });

  it('loading中の既存タブを再選択してもreadを重複実行しない', async () => {
    const api = installApi();
    const pendingRead = deferred<FileReadResult>();
    api.files.read.mockReturnValueOnce(pendingRead.promise);
    const { result } = renderHook(() => useFileTabs(options()));
    let firstOpen!: Promise<void>;

    await act(async () => {
      firstOpen = result.current.openEditorTab('/workspace/a', 'src/file.ts');
      await Promise.resolve();
    });

    expect(result.current.editorTabs[0]).toMatchObject({ loading: true, error: null });

    await act(async () => {
      await result.current.openEditorTab('/workspace/a', 'src/file.ts');
    });

    expect(api.files.read).toHaveBeenCalledTimes(1);

    pendingRead.resolve(fileReadResult('src/file.ts', 'loaded once'));
    await act(async () => {
      await firstOpen;
    });

    expect(result.current.editorTabs[0]).toMatchObject({
      loading: false,
      content: 'loaded once',
      originalContent: 'loaded once'
    });
  });

  it('cleanな既存タブの再選択ではディスク内容を再読込する', async () => {
    const api = installApi();
    api.files.read
      .mockResolvedValueOnce(fileReadResult('src/file.ts', 'initial disk content'))
      .mockResolvedValueOnce(fileReadResult('src/file.ts', 'external disk change'));
    const { result } = renderHook(() => useFileTabs(options()));

    await act(async () => {
      await result.current.openEditorTab('/workspace/a', 'src/file.ts');
    });
    await act(async () => {
      await result.current.openEditorTab('/workspace/a', 'src/file.ts');
    });

    expect(api.files.read).toHaveBeenCalledTimes(2);
    expect(result.current.editorTabs[0]).toMatchObject({
      content: 'external disk change',
      originalContent: 'external disk change',
      error: null
    });
  });

  it('clean再読込のerrorでは既存内容を保持し、再選択するとreadを再試行する', async () => {
    const api = installApi();
    api.files.read
      .mockResolvedValueOnce(fileReadResult('src/file.ts', 'initial disk content'))
      .mockResolvedValueOnce(fileReadError('src/file.ts', 'temporary read failure'))
      .mockResolvedValueOnce(fileReadResult('src/file.ts', 'recovered content'))
      .mockResolvedValueOnce(fileReadResult('src/file.ts', 'later disk content'));
    const { result } = renderHook(() => useFileTabs(options()));

    await act(async () => {
      await result.current.openEditorTab('/workspace/a', 'src/file.ts');
    });
    await act(async () => {
      await result.current.openEditorTab('/workspace/a', 'src/file.ts');
    });
    expect(result.current.editorTabs[0]).toMatchObject({
      content: 'initial disk content',
      originalContent: 'initial disk content',
      contentHash: 'hash:initial disk content',
      loading: false,
      error: 'temporary read failure'
    });

    await act(async () => {
      await result.current.openEditorTab('/workspace/a', 'src/file.ts');
    });

    expect(api.files.read).toHaveBeenCalledTimes(3);
    expect(result.current.editorTabs[0]).toMatchObject({
      content: 'recovered content',
      originalContent: 'recovered content',
      loading: false,
      error: null
    });

    await act(async () => {
      await result.current.openEditorTab('/workspace/a', 'src/file.ts');
    });

    expect(api.files.read).toHaveBeenCalledTimes(4);
    expect(result.current.editorTabs[0]).toMatchObject({
      content: 'later disk content',
      originalContent: 'later disk content',
      error: null
    });
  });

  it('readがthrowしても次の再選択で再試行できる', async () => {
    const api = installApi();
    api.files.read
      .mockRejectedValueOnce(new Error('IPC unavailable'))
      .mockResolvedValueOnce(fileReadResult('src/file.ts', 'recovered after throw'));
    const { result } = renderHook(() => useFileTabs(options()));

    await act(async () => {
      await result.current.openEditorTab('/workspace/a', 'src/file.ts');
    });
    expect(result.current.editorTabs[0]).toMatchObject({
      loading: false,
      error: 'Error: IPC unavailable'
    });

    await act(async () => {
      await result.current.openEditorTab('/workspace/a', 'src/file.ts');
    });

    expect(api.files.read).toHaveBeenCalledTimes(2);
    expect(result.current.editorTabs[0]).toMatchObject({
      content: 'recovered after throw',
      originalContent: 'recovered after throw',
      error: null
    });
  });

  it('同一render内の並行openを1回のreadへ集約する', async () => {
    const api = installApi();
    const pendingRead = deferred<FileReadResult>();
    api.files.read
      .mockReturnValueOnce(pendingRead.promise)
      .mockResolvedValueOnce(fileReadResult('src/file.ts', 'unexpected second response'));
    const { result } = renderHook(() => useFileTabs(options()));
    let firstOpen!: Promise<void>;
    let secondOpen!: Promise<void>;

    await act(async () => {
      firstOpen = result.current.openEditorTab('/workspace/a', 'src/file.ts');
      secondOpen = result.current.openEditorTab('/workspace/a', 'src/file.ts');
      await secondOpen;
    });

    expect(api.files.read).toHaveBeenCalledTimes(1);
    expect(result.current.editorTabs).toHaveLength(1);

    pendingRead.resolve(fileReadResult('src/file.ts', 'authoritative response'));
    await act(async () => {
      await firstOpen;
    });

    expect(result.current.editorTabs[0]).toMatchObject({
      content: 'authoritative response',
      originalContent: 'authoritative response',
      loading: false,
      error: null
    });
  });

  it('clean再読込の待機中に編集された場合は応答でdirty内容を上書きしない', async () => {
    const api = installApi();
    const pendingReload = deferred<FileReadResult>();
    api.files.read
      .mockResolvedValueOnce(fileReadResult('src/file.ts', 'initial content'))
      .mockReturnValueOnce(pendingReload.promise);
    const { result } = renderHook(() => useFileTabs(options()));

    await act(async () => {
      await result.current.openEditorTab('/workspace/a', 'src/file.ts');
    });
    const tabId = result.current.editorTabs[0]!.id;
    let reload!: Promise<void>;

    await act(async () => {
      reload = result.current.openEditorTab('/workspace/a', 'src/file.ts');
      await Promise.resolve();
    });
    act(() => {
      result.current.updateEditorContent(tabId, 'edit while reload is pending');
    });

    pendingReload.resolve(fileReadResult('src/file.ts', 'late disk response'));
    await act(async () => {
      await reload;
    });

    expect(api.files.read).toHaveBeenCalledTimes(2);
    expect(result.current.editorTabs[0]).toMatchObject({
      content: 'edit while reload is pending',
      originalContent: 'initial content',
      loading: false,
      error: null
    });
    expect(result.current.dirtyEditorTabs.map((tab) => tab.id)).toEqual([tabId]);
  });

  it('clean再読込の待機中に編集・保存しても古い応答で保存済み内容を上書きしない', async () => {
    const api = installApi();
    const pendingReload = deferred<FileReadResult>();
    api.files.read
      .mockResolvedValueOnce(fileReadResult('src/file.ts', 'initial content'))
      .mockReturnValueOnce(pendingReload.promise);
    const { result } = renderHook(() => useFileTabs(options()));

    await act(async () => {
      await result.current.openEditorTab('/workspace/a', 'src/file.ts');
    });
    const tabId = result.current.editorTabs[0]!.id;
    let reload!: Promise<void>;

    await act(async () => {
      reload = result.current.openEditorTab('/workspace/a', 'src/file.ts');
      await Promise.resolve();
    });
    act(() => {
      result.current.updateEditorContent(tabId, 'saved while reload is pending');
    });
    await act(async () => {
      await result.current.saveEditorTab(tabId);
    });
    expect(result.current.editorTabs[0]).toMatchObject({
      content: 'saved while reload is pending',
      originalContent: 'saved while reload is pending',
      contentHash: 'saved:saved while reload is pending'
    });

    pendingReload.resolve(fileReadResult('src/file.ts', 'stale disk response'));
    await act(async () => {
      await reload;
    });

    expect(api.files.read).toHaveBeenCalledTimes(2);
    expect(api.files.write).toHaveBeenCalledTimes(1);
    expect(result.current.editorTabs[0]).toMatchObject({
      content: 'saved while reload is pending',
      originalContent: 'saved while reload is pending',
      contentHash: 'saved:saved while reload is pending',
      error: null
    });
  });

  it('read中に閉じて同じファイルを再度開いてもplaceholderを復元しreadを重複しない', async () => {
    const api = installApi();
    const pendingRead = deferred<FileReadResult>();
    api.files.read.mockReturnValueOnce(pendingRead.promise);
    const { result } = renderHook(() => useFileTabs(options()));
    let firstOpen!: Promise<void>;

    await act(async () => {
      firstOpen = result.current.openEditorTab('/workspace/a', 'src/file.ts');
      await Promise.resolve();
    });
    const tabId = result.current.editorTabs[0]!.id;

    await act(async () => {
      await result.current.closeTab(tabId);
    });
    expect(result.current.editorTabs).toHaveLength(0);

    await act(async () => {
      await result.current.openEditorTab('/workspace/a', 'src/file.ts');
    });

    expect(api.files.read).toHaveBeenCalledTimes(1);
    expect(result.current.activeTabId).toBe(tabId);
    expect(result.current.editorTabs).toHaveLength(1);
    expect(result.current.editorTabs[0]).toMatchObject({
      id: tabId,
      loading: true,
      error: null
    });

    pendingRead.resolve(fileReadResult('src/file.ts', 'reopened content'));
    await act(async () => {
      await firstOpen;
    });

    expect(result.current.editorTabs[0]).toMatchObject({
      content: 'reopened content',
      originalContent: 'reopened content',
      loading: false,
      error: null
    });
  });

  it('project reset前の古いread応答を同じidの新しいタブへ適用しない', async () => {
    const api = installApi();
    const staleRead = deferred<FileReadResult>();
    api.files.read
      .mockReturnValueOnce(staleRead.promise)
      .mockResolvedValueOnce(fileReadResult('src/file.ts', 'fresh project content'));
    const { result } = renderHook(() => useFileTabs(options()));
    let oldOpen!: Promise<void>;

    await act(async () => {
      oldOpen = result.current.openEditorTab('/workspace/a', 'src/file.ts');
      await Promise.resolve();
    });
    act(() => {
      result.current.resetForProjectSwitch();
    });

    await act(async () => {
      await result.current.openEditorTab('/workspace/a', 'src/file.ts');
    });

    expect(api.files.read).toHaveBeenCalledTimes(2);
    expect(result.current.editorTabs[0]).toMatchObject({
      content: 'fresh project content',
      originalContent: 'fresh project content'
    });

    staleRead.resolve(fileReadResult('src/file.ts', 'stale project content'));
    await act(async () => {
      await oldOpen;
    });

    expect(result.current.editorTabs[0]).toMatchObject({
      content: 'fresh project content',
      originalContent: 'fresh project content'
    });
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

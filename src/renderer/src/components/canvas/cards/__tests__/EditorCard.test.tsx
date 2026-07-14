/**
 * EditorCard の smoke test。
 *
 * Issue #495: Canvas 上で 1 ファイルを編集するカード。Monaco Editor を直接マウントすると
 * worker の起動と canvas 描画で jsdom が落ちるため、`EditorView` 全体を vi.mock で
 * スタブ化し、「mount 時に window.api.files.read が projectRoot/relPath で呼ばれる」
 * 「タイトルが描画される」を最小限固定する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';

const editorViewMock = vi.hoisted(() => vi.fn());
const confirmMock = vi.hoisted(() => vi.fn(async () => true));

vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  NodeResizer: () => null,
  Position: { Left: 'left', Right: 'right' },
  useReactFlow: () => ({})
}));

vi.mock('../../../EditorView', () => ({
  EditorView: (props: unknown) => {
    editorViewMock(props);
    return <div data-testid="editor-view-stub" />;
  }
}));

vi.mock('../../../../lib/use-native-confirm', () => ({
  useNativeConfirm: () => confirmMock
}));

import EditorCard from '../EditorCard';
import { SettingsProvider } from '../../../../lib/settings-context';
import { ToastProvider } from '../../../../lib/toast-context';
import { DEFAULT_SETTINGS } from '../../../../../../types/shared';
import type { ReactNode } from 'react';

function installApi(): {
  read: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
} {
  const read = vi.fn(async () => ({
    ok: true,
    path: 'src/foo.ts',
    content: 'hello',
    isBinary: false,
    encoding: 'utf-8',
    mtimeMs: 1000,
    sizeBytes: 5,
    contentHash: 'hash-1',
    error: undefined
  }));
  const write = vi.fn(async () => ({
    ok: true,
    mtimeMs: 2000,
    sizeBytes: 7,
    contentHash: 'hash-2'
  }));
  window.api = {
    ...window.api,
    settings: {
      ...window.api?.settings,
      load: vi.fn(async () => DEFAULT_SETTINGS),
      save: vi.fn(async () => undefined),
      pickCustomMascot: vi.fn(async () => null),
      loadCustomMascot: vi.fn(async () => null),
      clearCustomMascot: vi.fn(async () => undefined)
    },
    app: {
      ...window.api?.app,
      setZoomLevel: vi.fn(async () => undefined)
    },
    files: { ...window.api?.files, read, write }
  };
  return { read, write };
}

type EditorViewMockProps = {
  content: string;
  dirty: boolean;
  readOnly?: boolean;
  readOnlyReason?: string;
  onChange: (value: string) => void;
  onSave: () => void;
};

function latestEditorProps(): EditorViewMockProps {
  return editorViewMock.mock.calls.at(-1)?.[0] as EditorViewMockProps;
}

function Wrapper({ children }: { children: ReactNode }): JSX.Element {
  return (
    <SettingsProvider>
      <ToastProvider>{children}</ToastProvider>
    </SettingsProvider>
  );
}

function renderCard(payload?: { projectRoot: string; relPath: string }) {
  const props = {
    id: 'editor-1',
    data: {
      title: 'foo.ts',
      payload: payload ?? { projectRoot: '/repo', relPath: 'src/foo.ts' }
    },
    selected: false,
    type: 'editor',
    dragging: false,
    isConnectable: true,
    zIndex: 0,
    xPos: 0,
    yPos: 0,
    targetPosition: 'left',
    sourcePosition: 'right'
  } as unknown as Parameters<typeof EditorCard>[0];
  return render(
    <Wrapper>
      <EditorCard {...props} />
    </Wrapper>
  );
}

describe('EditorCard (smoke)', () => {
  let originalApi: typeof window.api | undefined;

  beforeEach(() => {
    originalApi = window.api;
    editorViewMock.mockClear();
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
  });

  afterEach(() => {
    cleanup();
    if (originalApi === undefined) {
      Reflect.deleteProperty(window, 'api');
    } else {
      window.api = originalApi;
    }
    vi.restoreAllMocks();
  });

  it('mount 時に window.api.files.read(projectRoot, relPath) が呼ばれる', async () => {
    const api = installApi();

    renderCard();

    expect(await screen.findByText('foo.ts')).toBeInTheDocument();
    expect(screen.getByTestId('editor-view-stub')).toBeInTheDocument();
    await waitFor(() => expect(api.read).toHaveBeenCalledTimes(1));
    expect(api.read).toHaveBeenCalledWith('/repo', 'src/foo.ts');
  });

  it('保存時に読み込み時の mtime / size / encoding / hash を渡す (Issue #892)', async () => {
    const api = installApi();
    api.read.mockResolvedValueOnce({
      ok: true,
      path: 'src/foo.ts',
      content: 'hello',
      isBinary: false,
      encoding: 'shift_jis',
      mtimeMs: 1234,
      sizeBytes: 5,
      contentHash: 'hash-before'
    });

    renderCard();

    await waitFor(() => expect(latestEditorProps().content).toBe('hello'));
    act(() => latestEditorProps().onChange('changed'));
    await waitFor(() => expect(latestEditorProps().dirty).toBe(true));

    await act(async () => {
      latestEditorProps().onSave();
      await Promise.resolve();
    });

    await waitFor(() => expect(api.write).toHaveBeenCalledTimes(1));
    expect(api.write).toHaveBeenCalledWith(
      '/repo',
      'src/foo.ts',
      'changed',
      1234,
      5,
      'shift_jis',
      'hash-before'
    );
  });

  it('外部変更 conflict では確認後に encoding を保って強制上書きする', async () => {
    const api = installApi();
    api.read.mockResolvedValueOnce({
      ok: true,
      path: 'src/foo.ts',
      content: 'hello',
      isBinary: false,
      encoding: 'shift_jis',
      mtimeMs: 1234,
      sizeBytes: 5,
      contentHash: 'hash-before'
    });
    api.write
      .mockResolvedValueOnce({ ok: false, conflict: true, error: 'conflict' })
      .mockResolvedValueOnce({
        ok: true,
        mtimeMs: 3000,
        sizeBytes: 7,
        contentHash: 'hash-after'
      });

    renderCard();

    await waitFor(() => expect(latestEditorProps().content).toBe('hello'));
    act(() => latestEditorProps().onChange('changed'));
    await waitFor(() => expect(latestEditorProps().dirty).toBe(true));

    await act(async () => {
      latestEditorProps().onSave();
      await Promise.resolve();
    });

    await waitFor(() => expect(api.write).toHaveBeenCalledTimes(2));
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(api.write).toHaveBeenNthCalledWith(
      2,
      '/repo',
      'src/foo.ts',
      'changed',
      undefined,
      undefined,
      'shift_jis',
      undefined
    );
  });

  it('lossy 読み込み時は readOnly にし、保存をブロックする', async () => {
    const api = installApi();
    api.read.mockResolvedValueOnce({
      ok: true,
      path: 'src/foo.ts',
      content: 'hello',
      isBinary: false,
      encoding: 'lossy',
      mtimeMs: 1234,
      sizeBytes: 5,
      contentHash: 'hash-before'
    });

    renderCard();

    await waitFor(() => expect(latestEditorProps().readOnly).toBe(true));
    expect(latestEditorProps().readOnlyReason).toBeTruthy();
    act(() => latestEditorProps().onChange('changed'));
    await waitFor(() => expect(latestEditorProps().dirty).toBe(true));

    await act(async () => {
      latestEditorProps().onSave();
      await Promise.resolve();
    });

    expect(api.write).not.toHaveBeenCalled();
  });

  it('画像ファイルでは files.read を呼ばない (Issue #325)', async () => {
    const api = installApi();

    renderCard({ projectRoot: '/repo', relPath: 'public/icon.png' });

    expect(await screen.findByTestId('editor-view-stub')).toBeInTheDocument();
    // detectLanguage が 'image' を返すと files.read を skip。
    // mount 後の microtask を 1 周流しても read は呼ばれない。
    await Promise.resolve();
    expect(api.read).not.toHaveBeenCalled();
  });
});

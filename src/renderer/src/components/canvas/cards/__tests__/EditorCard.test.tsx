/**
 * EditorCard の smoke test。
 *
 * Issue #495: Canvas 上で 1 ファイルを編集するカード。Monaco Editor を直接マウントすると
 * worker の起動と canvas 描画で jsdom が落ちるため、`EditorView` 全体を vi.mock で
 * スタブ化し、「mount 時に window.api.files.read が projectRoot/relPath で呼ばれる」
 * 「タイトルが描画される」を最小限固定する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  NodeResizer: () => null,
  Position: { Left: 'left', Right: 'right' },
  useReactFlow: () => ({})
}));

vi.mock('../../../EditorView', () => ({
  EditorView: () => <div data-testid="editor-view-stub" />
}));

import EditorCard from '../EditorCard';
import { SettingsProvider } from '../../../../lib/settings-context';
import { ToastProvider } from '../../../../lib/toast-context';
import { DEFAULT_SETTINGS } from '../../../../../../types/shared';
import type { ReactNode } from 'react';

type TestWindow = Window &
  typeof globalThis & {
    api?: unknown;
  };

function installApi(): {
  read: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
} {
  const read = vi.fn(async () => ({
    ok: true,
    content: 'hello',
    isBinary: false,
    error: null
  }));
  const write = vi.fn(async () => ({ ok: true }));
  (window as TestWindow).api = {
    settings: {
      load: vi.fn(async () => DEFAULT_SETTINGS),
      save: vi.fn(async () => undefined)
    },
    app: {
      setProjectRoot: vi.fn(async () => undefined),
      setZoomLevel: vi.fn(async () => undefined)
    },
    files: { read, write }
  };
  return { read, write };
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
  let originalApi: unknown;

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

  it('mount 時に window.api.files.read(projectRoot, relPath) が呼ばれる', async () => {
    const api = installApi();

    renderCard();

    expect(await screen.findByText('foo.ts')).toBeInTheDocument();
    expect(screen.getByTestId('editor-view-stub')).toBeInTheDocument();
    await waitFor(() => expect(api.read).toHaveBeenCalledTimes(1));
    expect(api.read).toHaveBeenCalledWith('/repo', 'src/foo.ts');
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

/**
 * DiffCard の smoke test。
 *
 * Issue #495: Canvas 上で git diff を表示するカード。Monaco DiffEditor を直接マウントすると
 * worker の起動に失敗するため、`DiffView` 全体を vi.mock でスタブ化し
 * 「props 経由で window.api.git.diff が呼ばれる」「タイトルが描画される」だけを固定する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  NodeResizer: () => null,
  Position: { Left: 'left', Right: 'right' },
  useReactFlow: () => ({})
}));

vi.mock('../../../DiffView', () => ({
  DiffView: () => <div data-testid="diff-view-stub" />
}));

vi.mock('../../../../lib/use-files-changed', () => ({
  useFilesChanged: () => undefined
}));

import DiffCard from '../DiffCard';
import { SettingsProvider } from '../../../../lib/settings-context';
import { ToastProvider } from '../../../../lib/toast-context';
import { DEFAULT_SETTINGS } from '../../../../../../types/shared';
import type { ReactNode } from 'react';

type TestWindow = Window &
  typeof globalThis & {
    api?: unknown;
  };

function installApi(): { diff: ReturnType<typeof vi.fn> } {
  const diff = vi.fn(async () => ({
    relPath: 'src/foo.ts',
    headContent: 'old',
    workingContent: 'new',
    isBinary: false
  }));
  (window as TestWindow).api = {
    settings: {
      load: vi.fn(async () => DEFAULT_SETTINGS),
      save: vi.fn(async () => undefined)
    },
    app: {
      setProjectRoot: vi.fn(async () => undefined),
      setZoomLevel: vi.fn(async () => undefined)
    },
    git: { diff }
  };
  return { diff };
}

function Wrapper({ children }: { children: ReactNode }): JSX.Element {
  return (
    <SettingsProvider>
      <ToastProvider>{children}</ToastProvider>
    </SettingsProvider>
  );
}

function renderCard() {
  const props = {
    id: 'diff-1',
    data: {
      title: 'diff: src/foo.ts',
      payload: { projectRoot: '/repo', relPath: 'src/foo.ts' }
    },
    selected: false,
    type: 'diff',
    dragging: false,
    isConnectable: true,
    zIndex: 0,
    xPos: 0,
    yPos: 0,
    targetPosition: 'left',
    sourcePosition: 'right'
  } as unknown as Parameters<typeof DiffCard>[0];
  return render(
    <Wrapper>
      <DiffCard {...props} />
    </Wrapper>
  );
}

describe('DiffCard (smoke)', () => {
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

  it('mount 時に window.api.git.diff(projectRoot, relPath) が呼ばれる', async () => {
    const api = installApi();

    renderCard();

    expect(await screen.findByText('diff: src/foo.ts')).toBeInTheDocument();
    expect(screen.getByTestId('diff-view-stub')).toBeInTheDocument();
    await waitFor(() => expect(api.diff).toHaveBeenCalledTimes(1));
    expect(api.diff).toHaveBeenCalledWith('/repo', 'src/foo.ts', undefined);
  });
});

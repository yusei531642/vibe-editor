/**
 * FileTreeCard の smoke test。
 *
 * Issue #495: Canvas 上にファイルツリーを置くカード。FileTreePanel は内部で fs IPC や
 * FileTreeStateProvider に依存するため重く、ここでは vi.mock でスタブ化し
 *   1. data.title がヘッダに描画される
 *   2. mount しても例外を投げない
 * の最小限だけを固定する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  NodeResizer: () => null,
  Position: { Left: 'left', Right: 'right' },
  useReactFlow: () => ({})
}));

vi.mock('../../../FileTreePanel', () => ({
  FileTreePanel: () => <div data-testid="file-tree-panel-stub" />
}));

import FileTreeCard from '../FileTreeCard';
import { SettingsProvider } from '../../../../lib/settings-context';
import { ToastProvider } from '../../../../lib/toast-context';
import { DEFAULT_SETTINGS } from '../../../../../../types/shared';

type TestWindow = Window &
  typeof globalThis & {
    api?: unknown;
  };

function installApi(): void {
  (window as TestWindow).api = {
    settings: {
      load: vi.fn(async () => DEFAULT_SETTINGS),
      save: vi.fn(async () => undefined)
    },
    app: {
      setProjectRoot: vi.fn(async () => undefined),
      setZoomLevel: vi.fn(async () => undefined)
    },
    dialog: {
      openFolder: vi.fn(async () => null)
    }
  };
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
    id: 'tree-1',
    data: {
      title: 'Files',
      payload: { projectRoot: '/repo' }
    },
    selected: false,
    type: 'fileTree',
    dragging: false,
    isConnectable: true,
    zIndex: 0,
    xPos: 0,
    yPos: 0,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    targetPosition: 'left',
    sourcePosition: 'right'
  } as unknown as Parameters<typeof FileTreeCard>[0];
  return render(
    <Wrapper>
      <FileTreeCard {...props} />
    </Wrapper>
  );
}

describe('FileTreeCard (smoke)', () => {
  let originalApi: unknown;

  beforeEach(() => {
    originalApi = (window as TestWindow).api;
    installApi();
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

  it('data.title がヘッダに描画され、FileTreePanel スタブが配置される', async () => {
    renderCard();
    expect(await screen.findByText('Files')).toBeInTheDocument();
    expect(screen.getByTestId('file-tree-panel-stub')).toBeInTheDocument();
  });
});

/**
 * TerminalCard の smoke test。
 *
 * Issue #495: PTY / xterm 周りは TerminalView (= AgentNodeCard で別途検証) に委譲済みなので、
 * TerminalCard 自体の責務は「CardFrame で枠を作り、TerminalView に payload を渡す」配線のみ。
 * ここでは:
 *   1. NodeProps の data.title がヘッダに描画される
 *   2. mount しても例外を投げない (CardFrame + 子の渡し先が壊れていない)
 * を最小限で固定する。NodeResizer / Handle / TerminalView は重いので vi.mock で全置換。
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

vi.mock('../../../TerminalView', () => ({
  TerminalView: () => <div data-testid="terminal-view-stub" />
}));

import TerminalCard from '../TerminalCard';
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
    id: 'term-1',
    data: {
      title: 'Terminal A',
      payload: { agent: 'claude', agentId: 'agent-1', cwd: '/tmp' }
    },
    selected: false,
    type: 'terminal',
    dragging: false,
    isConnectable: true,
    zIndex: 0,
    xPos: 0,
    yPos: 0,
    targetPosition: 'left',
    sourcePosition: 'right'
  } as unknown as Parameters<typeof TerminalCard>[0];
  return render(
    <Wrapper>
      <TerminalCard {...props} />
    </Wrapper>
  );
}

describe('TerminalCard (smoke)', () => {
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

  it('data.title がヘッダに描画され、TerminalView スタブが配置される', async () => {
    renderCard();
    expect(await screen.findByText('Terminal A')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-view-stub')).toBeInTheDocument();
  });
});

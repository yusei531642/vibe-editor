import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

const terminalViewProps = vi.hoisted(() => [] as Array<{ visible?: boolean }>);

vi.mock('../../../../TerminalView', () => ({
  TerminalView: (props: { visible?: boolean }) => {
    terminalViewProps.push(props);
    return <div data-testid="agent-terminal-view-stub" data-visible={String(props.visible)} />;
  }
}));

import { TerminalOverlay } from '../TerminalOverlay';
import { SettingsProvider } from '../../../../../lib/settings-context';
import { useUiStore } from '../../../../../stores/ui';
import { DEFAULT_SETTINGS } from '../../../../../../../types/shared';

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
  return <SettingsProvider>{children}</SettingsProvider>;
}

function renderOverlay() {
  return render(
    <Wrapper>
      <TerminalOverlay
        cardId="agent-node-1"
        termRef={{ current: null }}
        payload={{ agentId: 'agent-1', teamId: 'team-1' }}
        title="Leader"
        roleProfileId="leader"
        cwd="/tmp/work"
        command="claude"
        args={['--print']}
        onStatus={vi.fn()}
        onActivity={vi.fn()}
      />
    </Wrapper>
  );
}

describe('TerminalOverlay visibility gate', () => {
  let originalApi: unknown;

  beforeEach(() => {
    originalApi = (window as TestWindow).api;
    installApi();
    terminalViewProps.length = 0;
    useUiStore.setState({ viewMode: 'ide' });
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

  it('IDE モードでは AgentNode の TerminalView を非表示扱いにする', async () => {
    useUiStore.setState({ viewMode: 'ide' });
    renderOverlay();
    expect(await screen.findByTestId('agent-terminal-view-stub')).toHaveAttribute(
      'data-visible',
      'false'
    );
    expect(terminalViewProps.at(-1)?.visible).toBe(false);
  });

  it('Canvas モードでは AgentNode の TerminalView を表示扱いにする', async () => {
    useUiStore.setState({ viewMode: 'canvas' });
    renderOverlay();
    expect(await screen.findByTestId('agent-terminal-view-stub')).toHaveAttribute(
      'data-visible',
      'true'
    );
    expect(terminalViewProps.at(-1)?.visible).toBe(true);
  });
});

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useTerminalTabs, type UseTerminalTabsOptions } from '../use-terminal-tabs';

function options(overrides: Partial<UseTerminalTabsOptions> = {}): UseTerminalTabsOptions {
  return {
    viewMode: 'ide',
    claudeReady: true,
    projectRoot: 'C:\\Users\\zooyo',
    showToast: vi.fn(),
    closeTeam: vi.fn(),
    ...overrides
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useTerminalTabs', () => {
  it('does not auto-create a terminal on the IDE initial screen', async () => {
    const { result } = renderHook(() => useTerminalTabs(options()));

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.terminalTabs).toHaveLength(0);
    expect(result.current.activeTerminalTabId).toBe(0);
  });

  it('keeps terminal creation explicit', () => {
    const { result } = renderHook(() => useTerminalTabs(options()));

    act(() => {
      result.current.addTerminalTab({ agent: 'claude' });
    });

    expect(result.current.terminalTabs).toHaveLength(1);
    expect(result.current.terminalTabs[0]?.label).toBe('Claude #1');
  });

  it('does not create a replacement terminal when the last tab is closed', () => {
    const { result } = renderHook(() => useTerminalTabs(options()));

    act(() => {
      result.current.addTerminalTab({ agent: 'claude' });
    });
    const tabId = result.current.terminalTabs[0]?.id;
    expect(tabId).toBeDefined();

    act(() => {
      result.current.closeTerminalTab(tabId as number);
    });

    expect(result.current.terminalTabs).toHaveLength(0);
    expect(result.current.activeTerminalTabId).toBe(0);
  });

  it('clears terminals on project switch without auto-starting Claude', () => {
    const { result } = renderHook(() => useTerminalTabs(options()));

    act(() => {
      result.current.addTerminalTab({ agent: 'claude' });
    });
    expect(result.current.terminalTabs).toHaveLength(1);

    act(() => {
      result.current.resetForProjectSwitch();
    });

    expect(result.current.terminalTabs).toHaveLength(0);
    expect(result.current.activeTerminalTabId).toBe(0);
  });
});

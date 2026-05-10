import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_TERMINALS,
  TERMINAL_WARN_THRESHOLD,
  useTerminalTabs,
  type UseTerminalTabsOptions
} from '../use-terminal-tabs';

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

  // ---- Issue #588: addTerminalTab の同期連打レース ----

  it('caps terminal count at MAX_TERMINALS even when invoked synchronously beyond the limit (#588)', () => {
    const showToast = vi.fn();
    const { result } = renderHook(() => useTerminalTabs(options({ showToast })));

    const initialNextId = result.current.nextTerminalIdRef.current;

    // 同期 (= 1 つの act 内で連続 invoke) で MAX_TERMINALS + 5 回 addTerminalTab() を呼ぶ。
    // 旧実装では updater 外で id ref が無条件 increment され、accepted フラグが
    // batching 下で false のままになる race があった。修正後は updater 内で reject 判定 →
    // id 採番 → tab 追加までが原子的に走るため、確実に MAX_TERMINALS で頭打ちになる。
    act(() => {
      for (let i = 0; i < MAX_TERMINALS + 5; i++) {
        result.current.addTerminalTab({ agent: 'claude' });
      }
    });

    expect(result.current.terminalTabs).toHaveLength(MAX_TERMINALS);

    // 上限到達トーストが少なくとも 1 回は呼ばれていること。
    const upperLimitCalls = showToast.mock.calls.filter(([msg]) =>
      String(msg).includes(`ターミナル上限（${MAX_TERMINALS}）`)
    );
    expect(upperLimitCalls.length).toBeGreaterThanOrEqual(1);

    // 閾値接近トーストが (TERMINAL_WARN_THRESHOLD 到達タイミングで) 1 回は呼ばれていること。
    const thresholdCalls = showToast.mock.calls.filter(([msg]) =>
      String(msg).includes(`ターミナル数が ${TERMINAL_WARN_THRESHOLD}`)
    );
    expect(thresholdCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('does not consume nextTerminalIdRef on rejected adds (#588)', () => {
    const { result } = renderHook(() => useTerminalTabs(options({ showToast: vi.fn() })));

    const startNextId = result.current.nextTerminalIdRef.current;

    act(() => {
      for (let i = 0; i < MAX_TERMINALS + 5; i++) {
        result.current.addTerminalTab({ agent: 'claude' });
      }
    });

    // 30 タブだけ確定。id ref は accepted 数 (= MAX_TERMINALS) しか進まない。
    // 旧実装では reject 分も含めた MAX_TERMINALS + 5 (= 35) 進んでいた。
    expect(result.current.terminalTabs).toHaveLength(MAX_TERMINALS);
    expect(result.current.nextTerminalIdRef.current).toBe(startNextId + MAX_TERMINALS);

    // タブ id が連番になっていることも確認 (= reject 分が穴あきにならない)。
    const ids = result.current.terminalTabs.map((t) => t.id);
    expect(ids).toEqual(
      Array.from({ length: MAX_TERMINALS }, (_, i) => startNextId + i)
    );
  });

  // ---- Issue #662: 永続化復元から渡された PTY size seed をタブに焼き付ける ----

  it('seeds initialCols/initialRows on the tab when AddTerminalTabOptions provides them (#662)', () => {
    const { result } = renderHook(() => useTerminalTabs(options()));

    act(() => {
      result.current.addTerminalTab({
        agent: 'claude',
        cwd: 'C:\\Users\\zooyo\\repo',
        initialCols: 142,
        initialRows: 38
      });
    });

    expect(result.current.terminalTabs).toHaveLength(1);
    const tab = result.current.terminalTabs[0]!;
    expect(tab.cwd).toBe('C:\\Users\\zooyo\\repo');
    expect(tab.initialCols).toBe(142);
    expect(tab.initialRows).toBe(38);
  });

  it('defaults initialCols/initialRows to null on a fresh user-created tab (#662)', () => {
    const { result } = renderHook(() => useTerminalTabs(options()));

    act(() => {
      result.current.addTerminalTab({ agent: 'claude' });
    });

    const tab = result.current.terminalTabs[0]!;
    expect(tab.initialCols).toBeNull();
    expect(tab.initialRows).toBeNull();
  });

  it('after the limit is reached, closing one tab allows adding exactly one more (#588)', () => {
    const { result } = renderHook(() => useTerminalTabs(options({ showToast: vi.fn() })));

    act(() => {
      for (let i = 0; i < MAX_TERMINALS; i++) {
        result.current.addTerminalTab({ agent: 'claude' });
      }
    });
    expect(result.current.terminalTabs).toHaveLength(MAX_TERMINALS);

    const firstId = result.current.terminalTabs[0]!.id;
    act(() => {
      result.current.closeTerminalTab(firstId);
    });
    expect(result.current.terminalTabs).toHaveLength(MAX_TERMINALS - 1);

    act(() => {
      result.current.addTerminalTab({ agent: 'claude' });
    });
    expect(result.current.terminalTabs).toHaveLength(MAX_TERMINALS);
  });
});

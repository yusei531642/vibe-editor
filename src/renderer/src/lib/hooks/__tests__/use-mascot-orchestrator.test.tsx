import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StatusMascotState } from '../../status-mascot';
import { useMascotOrchestrator } from '../use-mascot-orchestrator';

const SLEEP_THRESHOLD_MS = 3 * 60 * 1000;

function renderOrchestrator(baseState: StatusMascotState = 'idle') {
  let renders = 0;
  const hook = renderHook(
    ({ base }) => {
      renders++;
      return useMascotOrchestrator(base);
    },
    { initialProps: { base: baseState } }
  );
  return {
    ...hook,
    get renders() {
      return renders;
    }
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-09T00:00:00Z'));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useMascotOrchestrator', () => {
  it('does not rerender AppShell-level hook for ordinary input while still idle', () => {
    const hook = renderOrchestrator('idle');

    expect(hook.result.current.state).toBe('idle');
    expect(hook.renders).toBe(1);

    act(() => {
      window.dispatchEvent(new Event('mousemove'));
      vi.advanceTimersByTime(500);
      window.dispatchEvent(new Event('keydown'));
      vi.advanceTimersByTime(500);
      window.dispatchEvent(new Event('wheel'));
    });

    expect(hook.result.current.state).toBe('idle');
    expect(hook.renders).toBe(1);
  });

  it('enters sleep exactly when the idle threshold elapses', () => {
    const hook = renderOrchestrator('idle');

    act(() => {
      vi.advanceTimersByTime(SLEEP_THRESHOLD_MS - 1);
    });
    expect(hook.result.current.state).toBe('idle');
    expect(hook.renders).toBe(1);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(hook.result.current.state).toBe('sleep');
    expect(hook.renders).toBe(2);
  });

  it('leaves sleep on user input and schedules the next sleep transition', () => {
    const hook = renderOrchestrator('idle');

    act(() => {
      vi.advanceTimersByTime(SLEEP_THRESHOLD_MS);
    });
    expect(hook.result.current.state).toBe('sleep');

    act(() => {
      window.dispatchEvent(new Event('mousedown'));
    });
    expect(hook.result.current.state).toBe('idle');

    act(() => {
      vi.advanceTimersByTime(SLEEP_THRESHOLD_MS);
    });
    expect(hook.result.current.state).toBe('sleep');
  });
});

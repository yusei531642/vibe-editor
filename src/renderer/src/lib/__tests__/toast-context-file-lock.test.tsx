/**
 * Issue #525: Rust TeamHub が emit する `team:file-lock-conflict` を
 * ToastProvider が warning toast として可視化することを固定する。
 */
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../toast-context';

const mocks = vi.hoisted(() => ({
  subscribers: {} as Record<string, (payload: { message?: string }) => void>,
  unsubscribe: vi.fn()
}));

vi.mock('../i18n', () => ({
  useT: () => (key: string) => key
}));

vi.mock('../subscribe-event', () => ({
  subscribeEvent: vi.fn(
    (event: string, cb: (payload: { message?: string }) => void) => {
      mocks.subscribers[event] = cb;
      return mocks.unsubscribe;
    }
  )
}));

describe('ToastProvider file-lock conflict event', () => {
  beforeEach(() => {
    mocks.subscribers = {};
    mocks.unsubscribe.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('team:file-lock-conflict を warning toast として表示する', async () => {
    render(
      <ToastProvider>
        <div />
      </ToastProvider>
    );

    await waitFor(() => {
      expect(mocks.subscribers['team:file-lock-conflict']).toBeTruthy();
    });

    act(() => {
      mocks.subscribers['team:file-lock-conflict']({
        message: 'タスク #525 の file lock 競合: src/foo.rs held by agent-a'
      });
    });

    await waitFor(() => {
      const toast = document.querySelector('.toast--warning');
      expect(toast).not.toBeNull();
      expect(toast?.textContent).toContain('file lock 競合');
    });
  });
});

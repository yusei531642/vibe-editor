import { describe, expect, it, vi } from 'vitest';
import { reportRefreshFailure } from '../refresh-error';

describe('reportRefreshFailure (Issue #1139)', () => {
  it.each([
    ['sessions.list', 'toast.sessionsRefreshFailed'],
    ['git.status', 'toast.gitRefreshFailed']
  ] as const)('logs and shows an error toast for %s', (scope, message) => {
    const error = new Error('IPC failed');
    const showToast = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    reportRefreshFailure(scope, error, message, showToast);

    expect(warn).toHaveBeenCalledWith(`[refresh] ${scope} failed:`, error);
    expect(showToast).toHaveBeenCalledWith(message, { tone: 'error' });
  });
});

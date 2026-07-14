type ShowToast = (
  message: string,
  options?: { tone?: 'info' | 'success' | 'warning' | 'error' }
) => unknown;

/** Issue #1139: refresh失敗を空データと誤認させない共通通知。 */
export function reportRefreshFailure(
  scope: 'sessions.list' | 'git.status',
  error: unknown,
  message: string,
  showToast: ShowToast
): void {
  console.warn(`[refresh] ${scope} failed:`, error);
  showToast(message, { tone: 'error' });
}

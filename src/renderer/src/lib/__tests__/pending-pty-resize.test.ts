import { describe, expect, it } from 'vitest';
import { takePendingPtyResize } from '../pending-pty-resize';

describe('takePendingPtyResize', () => {
  it('deduplicates a pending grid already used to create the PTY', () => {
    const pendingRef = { current: { cols: 80, rows: 24 } };
    const lastScheduledRef = { current: null };

    expect(
      takePendingPtyResize(pendingRef, lastScheduledRef, { cols: 80, rows: 24 }),
    ).toBeNull();
    expect(pendingRef.current).toBeNull();
    expect(lastScheduledRef.current).toEqual({ cols: 80, rows: 24 });
  });

  it('returns a changed pending grid for one resize after create', () => {
    const pendingRef = { current: { cols: 132, rows: 41 } };

    expect(takePendingPtyResize(pendingRef, undefined, { cols: 80, rows: 24 })).toEqual({
      cols: 132,
      rows: 41,
    });
  });
});

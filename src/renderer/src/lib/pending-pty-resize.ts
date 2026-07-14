import type { MutableRefObject } from 'react';

export interface TerminalGrid {
  cols: number;
  rows: number;
}

export function takePendingPtyResize(
  pendingRef: MutableRefObject<TerminalGrid | null> | undefined,
  lastScheduledRef: MutableRefObject<TerminalGrid | null> | undefined,
  initialGrid: TerminalGrid,
): TerminalGrid | null {
  const pending = pendingRef?.current ?? null;
  if (pendingRef) pendingRef.current = null;
  if (!pending) return null;

  if (lastScheduledRef) lastScheduledRef.current = pending;
  return pending.cols === initialGrid.cols && pending.rows === initialGrid.rows ? null : pending;
}

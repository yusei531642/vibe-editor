export type TerminalWriteOutcome =
  | 'written'
  | 'suppressedInjecting'
  | 'droppedTooLarge'
  | 'droppedRateLimited'
  | 'sessionNotFound';

export interface TerminalWriteResult {
  outcome: TerminalWriteOutcome;
}

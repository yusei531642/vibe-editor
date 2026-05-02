export type TerminalInputGateResetReason =
  | 'compositionend'
  | 'compositioncancel'
  | 'blur'
  | 'focusout'
  | 'manual';

export interface TerminalInputGate {
  startComposition(): void;
  endComposition(): boolean;
  cancelComposition(): boolean;
  resetComposition(reason: TerminalInputGateResetReason): boolean;
  shouldForward(data: string): boolean;
  isComposing(): boolean;
  getSuppressedCount(): number;
}

export function createTerminalInputGate(): TerminalInputGate {
  let composing = false;
  let suppressedCount = 0;

  return {
    startComposition(): void {
      composing = true;
    },
    endComposition(): boolean {
      return this.resetComposition('compositionend');
    },
    cancelComposition(): boolean {
      return this.resetComposition('compositioncancel');
    },
    resetComposition(_reason: TerminalInputGateResetReason): boolean {
      const wasComposing = composing;
      composing = false;
      return wasComposing;
    },
    shouldForward(_data: string): boolean {
      if (!composing) return true;
      suppressedCount += 1;
      return false;
    },
    isComposing(): boolean {
      return composing;
    },
    getSuppressedCount(): number {
      return suppressedCount;
    }
  };
}

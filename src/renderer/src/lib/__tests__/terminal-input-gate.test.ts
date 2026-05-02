import { describe, expect, it } from 'vitest';
import { createTerminalInputGate } from '../terminal-input-gate';

describe('terminal input gate', () => {
  it('composition 中の入力を抑制し、compositionend 後に再開する', () => {
    const gate = createTerminalInputGate();

    expect(gate.shouldForward('a')).toBe(true);

    gate.startComposition();
    expect(gate.isComposing()).toBe(true);
    expect(gate.shouldForward('k')).toBe(false);
    expect(gate.getSuppressedCount()).toBe(1);

    expect(gate.endComposition()).toBe(true);
    expect(gate.isComposing()).toBe(false);
    expect(gate.shouldForward('確定')).toBe(true);
  });

  it('compositioncancel / blur / focusout で stuck 状態を解除する', () => {
    const gate = createTerminalInputGate();

    gate.startComposition();
    expect(gate.cancelComposition()).toBe(true);
    expect(gate.shouldForward('a')).toBe(true);

    gate.startComposition();
    expect(gate.resetComposition('blur')).toBe(true);
    expect(gate.shouldForward('b')).toBe(true);

    gate.startComposition();
    expect(gate.resetComposition('focusout')).toBe(true);
    expect(gate.shouldForward('c')).toBe(true);
  });

  it('composition 中の stuck は端末インスタンス間で共有されない', () => {
    const stuckGate = createTerminalInputGate();
    const healthyGate = createTerminalInputGate();

    stuckGate.startComposition();

    expect(stuckGate.shouldForward('x')).toBe(false);
    expect(healthyGate.shouldForward('y')).toBe(true);
    expect(healthyGate.isComposing()).toBe(false);
  });

  it('composing でない reset は no-op として扱える', () => {
    const gate = createTerminalInputGate();

    expect(gate.resetComposition('blur')).toBe(false);
    expect(gate.shouldForward('\r')).toBe(true);
  });
});

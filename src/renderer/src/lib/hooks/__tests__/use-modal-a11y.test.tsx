import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { nestedModalOwnsEscape, useModalA11y } from '../use-modal-a11y';

function ModalHarness({ onClose }: { onClose: () => void }): JSX.Element {
  const modal = useModalA11y(onClose);
  return (
    <div
      ref={modal.dialogRef}
      role="dialog"
      tabIndex={-1}
      data-modal-escape-owner="true"
      onKeyDown={modal.onKeyDown}
    >
      <button type="button">first</button>
      <button type="button">last</button>
    </div>
  );
}

describe('useModalA11y (Issue #1142)', () => {
  it('moves initial focus inside and wraps Tab in both directions', () => {
    render(<ModalHarness onClose={vi.fn()} />);
    const first = screen.getByRole('button', { name: 'first' });
    const last = screen.getByRole('button', { name: 'last' });

    expect(document.activeElement).toBe(first);
    last.focus();
    expect(fireEvent.keyDown(last, { key: 'Tab' })).toBe(false);
    expect(document.activeElement).toBe(first);
    first.focus();
    expect(fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(last);
  });

  it('owns Escape and closes only the nested modal', () => {
    const onClose = vi.fn();
    render(<ModalHarness onClose={onClose} />);
    const first = screen.getByRole('button', { name: 'first' });

    expect(nestedModalOwnsEscape()).toBe(true);
    expect(fireEvent.keyDown(first, { key: 'Escape' })).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

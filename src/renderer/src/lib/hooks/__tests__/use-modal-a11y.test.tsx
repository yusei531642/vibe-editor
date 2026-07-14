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

  it('recovers Tab and Escape after focus falls back to document.body', () => {
    const onClose = vi.fn();
    render(<ModalHarness onClose={onClose} />);
    const first = screen.getByRole('button', { name: 'first' });
    first.blur();

    expect(document.activeElement).toBe(document.body);
    expect(nestedModalOwnsEscape()).toBe(true);
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    first.blur();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('wraps Tab in both directions when the dialog root itself has focus', () => {
    render(<ModalHarness onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    const first = screen.getByRole('button', { name: 'first' });
    const last = screen.getByRole('button', { name: 'last' });

    dialog.focus();
    expect(fireEvent.keyDown(dialog, { key: 'Tab' })).toBe(false);
    expect(document.activeElement).toBe(first);

    dialog.focus();
    expect(fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(last);
  });

  it('keeps focus and uses the latest onClose when its identity changes', () => {
    const firstOnClose = vi.fn();
    const latestOnClose = vi.fn();
    const { rerender } = render(<ModalHarness onClose={firstOnClose} />);
    const last = screen.getByRole('button', { name: 'last' });
    last.focus();

    rerender(<ModalHarness onClose={latestOnClose} />);

    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: 'Escape' });
    expect(firstOnClose).not.toHaveBeenCalled();
    expect(latestOnClose).toHaveBeenCalledTimes(1);
  });

  it('yields Escape ownership while focus is in a foreground palette', () => {
    const onClose = vi.fn();
    render(
      <>
        <ModalHarness onClose={onClose} />
        <input aria-label="palette" />
      </>,
    );
    const palette = screen.getByRole('textbox', { name: 'palette' });
    palette.focus();

    expect(nestedModalOwnsEscape()).toBe(false);
    fireEvent.keyDown(palette, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});

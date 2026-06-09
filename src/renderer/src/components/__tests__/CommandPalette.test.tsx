import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CommandPalette } from '../CommandPalette';
import { SettingsProvider } from '../../lib/settings-context';
import type { Command } from '../../lib/commands';

const commands: Command[] = [
  {
    id: 'test-command',
    title: 'Test command',
    category: 'Test',
    run: vi.fn()
  }
];

function installWindowApi(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).api = {
    settings: {
      load: vi.fn(() => new Promise(() => undefined)),
      save: vi.fn(() => Promise.resolve())
    },
    app: {
      setProjectRoot: vi.fn(() => Promise.resolve()),
      setZoomLevel: vi.fn(() => Promise.resolve())
    }
  };
}

function renderPalette(open: boolean, onClose = vi.fn()) {
  const result = render(
    <SettingsProvider>
      <CommandPalette open={open} commands={commands} onClose={onClose} />
    </SettingsProvider>
  );
  return { ...result, onClose };
}

function paletteNode(open: boolean, onClose: () => void) {
  return (
    <SettingsProvider>
      <CommandPalette open={open} commands={commands} onClose={onClose} />
    </SettingsProvider>
  );
}

describe('CommandPalette', () => {
  beforeEach(() => {
    installWindowApi();
    Element.prototype.scrollIntoView = vi.fn();
    window.requestAnimationFrame = vi.fn(() => 1);
    window.cancelAnimationFrame = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  it('renders the backdrop through a body portal', () => {
    const { container } = renderPalette(true);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveClass('cmdp-backdrop');
    expect(dialog.parentElement).toBe(document.body);
    expect(container.querySelector('.cmdp-backdrop')).toBeNull();
  });

  it('Tab / Shift+Tab を dialog 内に trap して背後 UI へ抜けさせない (Issue #846)', () => {
    const behindButton = document.createElement('button');
    behindButton.textContent = 'Behind UI';
    document.body.appendChild(behindButton);

    renderPalette(true);

    const input = screen.getByRole('combobox');
    input.focus();

    expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(false);
    expect(input).toHaveFocus();

    expect(fireEvent.keyDown(input, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(input).toHaveFocus();
    expect(behindButton).not.toHaveFocus();
  });

  it('閉じた後に CommandPalette を開く前の要素へ focus を戻す (Issue #846)', () => {
    const opener = document.createElement('button');
    opener.textContent = 'Open palette';
    document.body.appendChild(opener);
    opener.focus();

    const onClose = vi.fn();
    const { rerender } = render(paletteNode(true, onClose));

    const input = screen.getByRole('combobox');
    input.focus();
    expect(input).toHaveFocus();

    rerender(paletteNode(false, onClose));

    expect(opener).toHaveFocus();
  });
});

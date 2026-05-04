import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
  });

  it('renders the backdrop through a body portal', () => {
    const { container } = render(
      <SettingsProvider>
        <CommandPalette open commands={commands} onClose={vi.fn()} />
      </SettingsProvider>
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveClass('cmdp-backdrop');
    expect(dialog.parentElement).toBe(document.body);
    expect(container.querySelector('.cmdp-backdrop')).toBeNull();
  });
});

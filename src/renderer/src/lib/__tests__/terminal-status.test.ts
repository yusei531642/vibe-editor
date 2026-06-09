import { describe, expect, it } from 'vitest';
import {
  formatTerminalRuntimeStatus,
  terminalStatusIsBlocked,
  terminalStatusIsWorking
} from '../terminal-status';

function t(key: string, params?: Record<string, string | number>): string {
  const dict: Record<string, string> = {
    'terminal.status.starting': 'Starting {command}…',
    'terminal.status.running': 'Running: {command}',
    'terminal.status.exited': 'Exited (exitCode={exitCode})',
    'terminal.status.spawnFailed': 'Start failed: {error}',
    'terminal.status.reconnect': 'Reconnected: {command}',
    'terminal.status.reconnectRestored': 'Reconnected (restored output): {command}',
    'terminal.status.exception': 'Exception: {error}'
  };
  let out = dict[key] ?? key;
  for (const [param, value] of Object.entries(params ?? {})) {
    out = out.replace(`{${param}}`, String(value));
  }
  return out;
}

describe('terminal runtime status', () => {
  it('formats status at render time through i18n keys', () => {
    expect(formatTerminalRuntimeStatus({ kind: 'starting', command: 'claude' }, t)).toBe(
      'Starting claude…'
    );
    expect(formatTerminalRuntimeStatus({ kind: 'reconnecting', command: 'codex', restored: true }, t)).toBe(
      'Reconnected (restored output): codex'
    );
    expect(formatTerminalRuntimeStatus({ kind: 'spawn_failed', error: 'not found' }, t)).toBe(
      'Start failed: not found'
    );
  });

  it('keeps mascot state detection independent from display text', () => {
    expect(terminalStatusIsWorking({ kind: 'starting', command: 'claude' })).toBe(true);
    expect(terminalStatusIsWorking({ kind: 'running', command: 'claude' })).toBe(false);
    expect(terminalStatusIsBlocked({ kind: 'exception', error: 'boom' })).toBe(true);
    expect(terminalStatusIsBlocked({ kind: 'running', command: 'claude' })).toBe(false);
  });
});

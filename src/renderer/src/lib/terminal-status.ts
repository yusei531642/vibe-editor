export type TerminalRuntimeStatusKind =
  | 'starting'
  | 'running'
  | 'exited'
  | 'spawn_failed'
  | 'reconnecting'
  | 'exception';

export interface TerminalRuntimeStatus {
  kind: TerminalRuntimeStatusKind;
  command?: string;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  restored?: boolean;
}

type TFn = (key: string, params?: Record<string, string | number>) => string;

export function formatTerminalRuntimeStatus(
  status: TerminalRuntimeStatus | null | undefined,
  t: TFn
): string {
  if (!status) return '';
  switch (status.kind) {
    case 'starting':
      return t('terminal.status.starting', { command: status.command ?? '' });
    case 'running':
      return t('terminal.status.running', { command: status.command ?? '' });
    case 'exited':
      return t('terminal.status.exited', { exitCode: status.exitCode ?? '' });
    case 'spawn_failed':
      return t('terminal.status.spawnFailed', { error: status.error ?? '' });
    case 'reconnecting':
      return t(status.restored ? 'terminal.status.reconnectRestored' : 'terminal.status.reconnect', {
        command: status.command ?? ''
      });
    case 'exception':
      return t('terminal.status.exception', { error: status.error ?? '' });
    default:
      return '';
  }
}

export function terminalStatusIsWorking(status: TerminalRuntimeStatus | null | undefined): boolean {
  return status?.kind === 'starting' || status?.kind === 'reconnecting';
}

export function terminalStatusIsBlocked(status: TerminalRuntimeStatus | null | undefined): boolean {
  return status?.kind === 'spawn_failed' || status?.kind === 'exception' || status?.kind === 'exited';
}

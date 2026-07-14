import type { TerminalExitInfo } from '../../../types/shared';

export type TerminalDiagnostic =
  | { kind: 'exited'; info: TerminalExitInfo }
  | { kind: 'spawn_failed'; error?: string }
  | { kind: 'exception'; error: string };

export interface FormattedTerminalDiagnostic {
  message: string;
  tone: 'warning' | 'error';
  tailHeading?: string;
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

export function formatTerminalDiagnostic(
  diagnostic: TerminalDiagnostic,
  t: Translate
): FormattedTerminalDiagnostic {
  switch (diagnostic.kind) {
    case 'exited': {
      const { exitCode, signal } = diagnostic.info;
      const status = signal ? `exitCode=${exitCode}, signal=${signal}` : `exitCode=${exitCode}`;
      return {
        message: t('terminal.diagnostic.exited', { status }),
        tone: 'warning',
        tailHeading: diagnostic.info.tail
          ? t('terminal.diagnostic.finalOutput')
          : undefined
      };
    }
    case 'spawn_failed':
      return {
        message: t('terminal.diagnostic.spawnFailed', {
          error: diagnostic.error || t('terminal.diagnostic.unknownError')
        }),
        tone: 'error'
      };
    case 'exception':
      return {
        message: t('terminal.diagnostic.exception', { error: diagnostic.error }),
        tone: 'error'
      };
  }
}

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

export function formatTerminalDiagnosticFallback(
  diagnostic: TerminalDiagnostic
): FormattedTerminalDiagnostic {
  if (diagnostic.kind === 'exited') {
    const { exitCode, signal, tail } = diagnostic.info;
    return {
      message: `[Process exited: exitCode=${exitCode}${signal ? `, signal=${signal}` : ''}]`,
      tone: 'warning',
      tailHeading: tail ? '── Final output (possible cause) ──' : undefined
    };
  }
  return {
    message:
      diagnostic.kind === 'spawn_failed'
        ? `[Start error] ${diagnostic.error || 'Unknown error'}`
        : `[Exception] ${diagnostic.error}`,
    tone: 'error'
  };
}

export function renderTerminalDiagnostic(
  diagnostic: TerminalDiagnostic,
  formatted: FormattedTerminalDiagnostic
): string {
  const color = formatted.tone === 'warning' ? '\x1b[33m' : '\x1b[31m';
  const tail = diagnostic.kind === 'exited' ? diagnostic.info.tail : undefined;
  return `\r\n${color}${formatted.message}\x1b[0m${tail && formatted.tailHeading ? `\r\n\x1b[90m${formatted.tailHeading}\x1b[0m\r\n${tail.replace(/\n/g, '\r\n')}` : ''}`;
}

export function createTerminalDiagnosticWriter(
  writeLine: (line: string) => void,
  getFormatter: () => ((diagnostic: TerminalDiagnostic) => FormattedTerminalDiagnostic) | undefined
): (diagnostic: TerminalDiagnostic) => void {
  return (diagnostic) => {
    const formatted = getFormatter()?.(diagnostic) ?? formatTerminalDiagnosticFallback(diagnostic);
    writeLine(renderTerminalDiagnostic(diagnostic, formatted));
  };
}

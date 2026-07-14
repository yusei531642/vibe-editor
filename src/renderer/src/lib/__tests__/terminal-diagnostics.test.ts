import { describe, expect, it } from 'vitest';
import { translate } from '../i18n';
import {
  formatTerminalDiagnostic,
  formatTerminalDiagnosticFallback,
  renderTerminalDiagnostic
} from '../terminal-diagnostics';

describe('terminal diagnostics', () => {
  it.each([
    ['ja', '[プロセス終了: exitCode=7, signal=SIGTERM]', '── 最終出力 (死因の可能性) ──'],
    ['en', '[Process exited: exitCode=7, signal=SIGTERM]', '── Final output (possible cause) ──']
  ] as const)('%s の終了ラベルを整形し動的情報を保持する', (language, message, heading) => {
    const formatted = formatTerminalDiagnostic(
      { kind: 'exited', info: { exitCode: 7, signal: 'SIGTERM', tail: 'raw output' } },
      (key, params) => translate(language, key, params)
    );

    expect(formatted).toEqual({ message, tone: 'warning', tailHeading: heading });
  });

  it('tail が無い終了では見出しを返さない', () => {
    expect(
      formatTerminalDiagnostic(
        { kind: 'exited', info: { exitCode: 0 } },
        (key, params) => translate('en', key, params)
      ).tailHeading
    ).toBeUndefined();
  });

  it.each([
    ['ja', '[起動エラー] 不明なエラー', '[例外] boom'],
    ['en', '[Start error] Unknown error', '[Exception] boom']
  ] as const)('%s の起動失敗・例外を整形する', (language, spawnMessage, exceptionMessage) => {
    const t = (key: string, params?: Record<string, string | number>): string =>
      translate(language, key, params);
    expect(formatTerminalDiagnostic({ kind: 'spawn_failed' }, t).message).toBe(spawnMessage);
    expect(formatTerminalDiagnostic({ kind: 'exception', error: 'boom' }, t).message).toBe(
      exceptionMessage
    );
  });

  it('formatter未指定時も英語fallbackとANSI tailを維持する', () => {
    const diagnostic = {
      kind: 'exited' as const,
      info: { exitCode: 7, signal: 'SIGTERM', tail: 'line1\nline2' }
    };
    const rendered = renderTerminalDiagnostic(
      diagnostic,
      formatTerminalDiagnosticFallback(diagnostic)
    );

    expect(rendered).toContain('[Process exited: exitCode=7, signal=SIGTERM]');
    expect(rendered).toContain('── Final output (possible cause) ──');
    expect(rendered).toContain('line1\r\nline2');
  });
});

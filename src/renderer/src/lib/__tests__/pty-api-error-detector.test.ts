import { describe, expect, it } from 'vitest';
import { createApiErrorDetector } from '../pty-api-error-detector';

describe('createApiErrorDetector', () => {
  it('detects the claude "API error · Retrying" loop once', () => {
    const d = createApiErrorDetector();
    expect(d.observe('booting up...\n')).toBe(false);
    expect(
      d.observe('API error (Connection error.) · Retrying in 1 seconds… (attempt 1/10)')
    ).toBe(true);
    // 1 セッション 1 回だけ: 以降の同種出力では false。
    expect(d.observe('API error · Retrying (attempt 2/10)')).toBe(false);
  });

  it('matches "API error" + "attempt" even without "Retrying"', () => {
    const d = createApiErrorDetector();
    expect(d.observe('API error: overloaded (attempt 3)')).toBe(true);
  });

  it('detects a pattern split across chunk boundaries', () => {
    const d = createApiErrorDetector();
    expect(d.observe('...some API err')).toBe(false);
    expect(d.observe('or occurred, Retrying now')).toBe(true);
  });

  it('ignores ANSI color codes around the keywords', () => {
    const d = createApiErrorDetector();
    expect(d.observe('\x1b[31mAPI error\x1b[0m · \x1b[33mRetrying\x1b[0m')).toBe(true);
  });

  it('does not fire on unrelated output (fail-safe)', () => {
    const d = createApiErrorDetector();
    expect(d.observe('Welcome to Claude Code\n')).toBe(false);
    expect(d.observe('error: file not found\n')).toBe(false); // "API error" ではない
    expect(d.observe('retrying connection...\n')).toBe(false); // "API error" 不在
  });

  it('reset() re-arms the detector for a fresh spawn', () => {
    const d = createApiErrorDetector();
    expect(d.observe('API error, Retrying')).toBe(true);
    expect(d.observe('API error, Retrying')).toBe(false);
    d.reset();
    expect(d.observe('API error, Retrying')).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import {
  normalizeLeadingDashes,
  parseShellArgs,
  parseShellArgsStrict
} from '../parse-args';

describe('parseShellArgs', () => {
  it('splits on whitespace', () => {
    expect(parseShellArgs('--model opus --add-dir foo')).toEqual([
      '--model',
      'opus',
      '--add-dir',
      'foo'
    ]);
  });

  it('keeps quoted segments with spaces together', () => {
    expect(parseShellArgs('--add-dir "D:/my projects/foo"')).toEqual([
      '--add-dir',
      'D:/my projects/foo'
    ]);
  });
});

describe('parseShellArgs Unicode dash normalization (Issue #449)', () => {
  it('normalizes a leading EN DASH (U+2013) to "--"', () => {
    // 入力: 1 文字の en dash + フラグ名 (Codex CLI の autocorrect ケース)
    expect(parseShellArgs('–dangerously-bypass-approvals-and-sandbox')).toEqual([
      '--dangerously-bypass-approvals-and-sandbox'
    ]);
  });

  it('normalizes a leading EM DASH (U+2014) to "--"', () => {
    expect(parseShellArgs('—foo')).toEqual(['--foo']);
  });

  it('collapses a mixed run of Unicode dash + ASCII hyphen at token start', () => {
    // 例: en dash の直後に ASCII hyphen が混じっていてもまとめて "--" に潰す
    expect(parseShellArgs('–-foo')).toEqual(['--foo']);
    expect(parseShellArgs('––foo')).toEqual(['--foo']);
  });

  it('does not touch ASCII hyphens', () => {
    expect(parseShellArgs('--foo -x')).toEqual(['--foo', '-x']);
  });

  it('does not touch Unicode dashes inside the value side', () => {
    // option 名は ASCII '-' から始まるので、value 側に en dash があってもそのまま
    expect(parseShellArgs('--foo=a–b')).toEqual(['--foo=a–b']);
  });

  it('normalizes within multi-token input', () => {
    expect(parseShellArgs('–model opus ––yes')).toEqual([
      '--model',
      'opus',
      '--yes'
    ]);
  });
});

describe('parseShellArgsStrict', () => {
  it('reports unterminated quote', () => {
    const result = parseShellArgsStrict('--foo "bar');
    expect(result.unterminatedQuote).toBe(true);
    expect(result.hasUnicodeDash).toBe(false);
  });

  it('reports hasUnicodeDash when a token starts with a Unicode dash', () => {
    const result = parseShellArgsStrict('–dangerously-bypass-approvals-and-sandbox');
    expect(result.hasUnicodeDash).toBe(true);
    expect(result.args).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
  });

  it('does not report hasUnicodeDash for ASCII-only input', () => {
    const result = parseShellArgsStrict('--foo --bar');
    expect(result.hasUnicodeDash).toBe(false);
  });

  it('reports both flags when both issues exist', () => {
    const result = parseShellArgsStrict('–foo "unterminated');
    expect(result.unterminatedQuote).toBe(true);
    expect(result.hasUnicodeDash).toBe(true);
  });
});

describe('normalizeLeadingDashes', () => {
  it('returns empty string as-is', () => {
    expect(normalizeLeadingDashes('')).toBe('');
  });

  it.each([
    ['‐foo', '--foo'], // U+2010 HYPHEN
    ['‑foo', '--foo'], // U+2011 NON-BREAKING HYPHEN
    ['‒foo', '--foo'], // U+2012 FIGURE DASH
    ['–foo', '--foo'], // U+2013 EN DASH
    ['—foo', '--foo'], // U+2014 EM DASH
    ['―foo', '--foo'], // U+2015 HORIZONTAL BAR
    ['−foo', '--foo'], // U+2212 MINUS SIGN
    ['﹘foo', '--foo'], // U+FE58 SMALL EM DASH
    ['﹣foo', '--foo'], // U+FE63 SMALL HYPHEN-MINUS
    ['－foo', '--foo'] // U+FF0D FULLWIDTH HYPHEN-MINUS
  ])('normalizes leading %s to "--"', (input, expected) => {
    expect(normalizeLeadingDashes(input)).toBe(expected);
  });

  it('leaves ASCII-leading tokens untouched', () => {
    expect(normalizeLeadingDashes('--foo')).toBe('--foo');
    expect(normalizeLeadingDashes('-x')).toBe('-x');
    expect(normalizeLeadingDashes('foo')).toBe('foo');
  });
});

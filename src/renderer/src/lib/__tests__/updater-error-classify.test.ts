// Issue #609: silentCheckForUpdate が tauri-plugin-updater から受け取る error を
// signature / network / other に分類するロジックの単体テスト。
//
// vitest 環境では import.meta.env.PROD = false のため `silentCheckForUpdate` 自体は
// 走らないが、`classifyUpdaterError` は純関数なので分類ロジックだけ独立して検証する。

import { describe, expect, it } from 'vitest';
import { classifyUpdaterError } from '../updater-check';

describe('classifyUpdaterError', () => {
  describe('signature errors', () => {
    it('classifies "signature verification failed" as signature', () => {
      expect(classifyUpdaterError(new Error('signature verification failed'))).toBe('signature');
    });

    it('classifies "minisign error" as signature', () => {
      expect(classifyUpdaterError('Minisign verification error')).toBe('signature');
    });

    it('classifies "untrusted comment" as signature', () => {
      expect(classifyUpdaterError(new Error('untrusted comment in pubkey'))).toBe('signature');
    });

    it('matches case-insensitively', () => {
      expect(classifyUpdaterError(new Error('SIGNATURE INVALID'))).toBe('signature');
    });
  });

  describe('network errors', () => {
    it('classifies "network unreachable" as network', () => {
      expect(classifyUpdaterError(new Error('network is unreachable'))).toBe('network');
    });

    it('classifies "request timed out" as network', () => {
      expect(classifyUpdaterError(new Error('request timed out'))).toBe('network');
    });

    it('classifies HTTP status errors as network', () => {
      expect(classifyUpdaterError('HTTP 503 Service Unavailable')).toBe('network');
    });

    it('classifies "all endpoints failed" as network', () => {
      expect(classifyUpdaterError(new Error('all endpoints failed'))).toBe('network');
    });

    it('classifies DNS / TLS errors as network', () => {
      expect(classifyUpdaterError('dns lookup failed')).toBe('network');
      expect(classifyUpdaterError('tls handshake error')).toBe('network');
      expect(classifyUpdaterError('ssl certificate problem')).toBe('network');
    });
  });

  describe('other errors', () => {
    it('classifies unrelated errors as other', () => {
      expect(classifyUpdaterError(new Error('unexpected end of stream'))).toBe('other');
    });

    it('classifies undefined as other', () => {
      expect(classifyUpdaterError(undefined)).toBe('other');
    });

    it('classifies plain object as other', () => {
      expect(classifyUpdaterError({ code: 42 })).toBe('other');
    });
  });

  describe('signature priority over network', () => {
    it('prefers signature when both keywords appear', () => {
      // tauri-plugin-updater の error 文字列は時に "request signature failed" のように
      // 両方のキーワードを含むことがある。signature を優先する。
      expect(classifyUpdaterError(new Error('signature on http request invalid'))).toBe(
        'signature'
      );
    });
  });
});

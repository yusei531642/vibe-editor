import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BOOTSTRAP_LANGUAGE_STORAGE_KEY,
  resolveBootstrapLanguage,
  syncBootstrapLanguage
} from '../i18n';

describe('bootstrap language', () => {
  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('lang');
    vi.restoreAllMocks();
  });

  it.each(['ja', 'en'] as const)('保存済みの %s を優先する', (language) => {
    window.localStorage.setItem(BOOTSTRAP_LANGUAGE_STORAGE_KEY, language);
    expect(resolveBootstrapLanguage()).toBe(language);
  });

  it('未知の保存値は無視してブラウザ言語を使う', () => {
    window.localStorage.setItem(BOOTSTRAP_LANGUAGE_STORAGE_KEY, 'fr');
    vi.spyOn(window.navigator, 'language', 'get').mockReturnValue('ja-JP');
    expect(resolveBootstrapLanguage()).toBe('ja');
  });

  it('localStorage が例外でもブラウザ言語へフォールバックする', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    vi.spyOn(window.navigator, 'language', 'get').mockReturnValue('en-US');
    expect(resolveBootstrapLanguage()).toBe('en');
  });

  it('言語キャッシュと html lang を同期する', () => {
    syncBootstrapLanguage('en');
    expect(window.localStorage.getItem(BOOTSTRAP_LANGUAGE_STORAGE_KEY)).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { insertPastedImageToPty } from '../paste-image-client';

class SuccessfulFileReader {
  result: string | ArrayBuffer | null = null;
  error: DOMException | null = null;
  onerror: (() => void) | null = null;
  onload: (() => void) | null = null;

  readAsDataURL(): void {
    this.result = 'data:image/png;base64,aW1hZ2U=';
    this.onload?.();
  }
}

describe('insertPastedImageToPty', () => {
  const originalFileReader = globalThis.FileReader;
  const originalApi = window.api;

  afterEach(() => {
    globalThis.FileReader = originalFileReader;
    if (originalApi === undefined) {
      delete (window as Window & { api?: typeof window.api }).api;
    } else {
      window.api = originalApi;
    }
    vi.restoreAllMocks();
  });

  it('backend error が無い失敗では呼び元の翻訳済みfallbackを返す', async () => {
    globalThis.FileReader = SuccessfulFileReader as unknown as typeof FileReader;
    window.api = {
      terminal: {
        savePastedImage: vi.fn(async () => ({ ok: false, path: null }))
      }
    } as typeof window.api;

    const result = await insertPastedImageToPty(
      new Blob(['image']),
      'image/png',
      vi.fn(),
      '不明なエラー'
    );

    expect(result).toEqual({ ok: false, error: '不明なエラー' });
  });
});

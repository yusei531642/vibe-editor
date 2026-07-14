import { afterEach, describe, expect, it, vi } from 'vitest';
import { insertPastedImageToPty } from '../paste-image-client';

type TestWindow = Window & typeof globalThis & { api?: unknown };

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
  const originalApi = (window as TestWindow).api;

  afterEach(() => {
    globalThis.FileReader = originalFileReader;
    if (originalApi === undefined) {
      delete (window as TestWindow).api;
    } else {
      (window as TestWindow).api = originalApi;
    }
    vi.restoreAllMocks();
  });

  it('backend error が無い失敗では呼び元の翻訳済みfallbackを返す', async () => {
    globalThis.FileReader = SuccessfulFileReader as unknown as typeof FileReader;
    (window as TestWindow).api = {
      terminal: {
        savePastedImage: vi.fn(async () => ({ ok: false, path: null }))
      }
    };

    const result = await insertPastedImageToPty(
      new Blob(['image']),
      'image/png',
      vi.fn(async () => ({ outcome: 'written' as const })),
      '不明なエラー'
    );

    expect(result).toEqual({ ok: false, error: '不明なエラー' });
  });

  it('writtenのときだけ画像パス挿入を成功扱いにする', async () => {
    (window as TestWindow).api = {
      terminal: {
        savePastedImage: vi.fn(async () => ({ ok: true, path: 'C:\\tmp\\shot image.png' }))
      }
    };
    const write = vi.fn(async () => ({ outcome: 'written' as const }));

    await expect(
      insertPastedImageToPty(new Blob(['image']), 'image/png', write)
    ).resolves.toEqual({ ok: true });
    expect(write).toHaveBeenCalledWith('"C:\\tmp\\shot image.png" ');
  });

  it.each([
    'suppressedInjecting',
    'droppedTooLarge',
    'droppedRateLimited',
    'sessionNotFound'
  ] as const)('%sを成功扱いにしない', async (outcome) => {
    (window as TestWindow).api = {
      terminal: {
        savePastedImage: vi.fn(async () => ({ ok: true, path: '/tmp/image.png' }))
      }
    };

    await expect(
      insertPastedImageToPty(new Blob(['image']), 'image/png', async () => ({ outcome }))
    ).resolves.toEqual({
      ok: false,
      error: outcome,
      errorKey: `terminal.pasteImage.${outcome}`
    });
  });
});

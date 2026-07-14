import { afterEach, describe, expect, it, vi } from 'vitest';
import { insertPastedImageToPty } from '../paste-image-client';

type TestWindow = Window & typeof globalThis & { api?: unknown };

describe('insertPastedImageToPty', () => {
  const originalApi = (window as TestWindow).api;

  afterEach(() => {
    if (originalApi === undefined) delete (window as TestWindow).api;
    else (window as TestWindow).api = originalApi;
    vi.restoreAllMocks();
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

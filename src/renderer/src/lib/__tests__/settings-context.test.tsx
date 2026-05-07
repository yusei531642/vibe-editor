/**
 * settings-context (SettingsProvider / useSettings) の振る舞いテスト。
 *
 * Issue #495: PR #491 で settings の保存失敗 / projectRoot 同期失敗が console.warn
 * から Toast 通知に昇格した。renderer のグローバル状態である本 context が
 *   1. window.api.settings.load() の値で初期化される
 *   2. update() 後の debounce save が window.api.settings.save() を呼ぶ
 *   3. save() が reject すると bridgedToast 経由で Toast を出す
 * の不変式を満たすことを固定する。
 *
 * 注意: SettingsProvider は内部で `import('./webview-zoom')` の動的 import を
 * useEffect から呼ぶため、fake timers を使うとそこが実時間に依存して詰まる。
 * このファイルでは fake timers は使わず、200ms debounce は実時間経過を
 * `await waitFor()` で待つ方針にする。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SettingsProvider, useSettings } from '../settings-context';
import { ToastProvider } from '../toast-context';
import { DEFAULT_SETTINGS, type AppSettings } from '../../../../types/shared';

type TestWindow = Window &
  typeof globalThis & {
    api?: unknown;
  };

interface MockApi {
  settings: {
    load: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
  };
  app: {
    setProjectRoot: ReturnType<typeof vi.fn>;
    setZoomLevel: ReturnType<typeof vi.fn>;
  };
}

function installApi(initial?: Partial<AppSettings>, saveImpl?: () => Promise<void>): MockApi {
  const api: MockApi = {
    settings: {
      load: vi.fn(async () => ({ ...DEFAULT_SETTINGS, ...(initial ?? {}) })),
      save: vi.fn(saveImpl ?? (async () => undefined))
    },
    app: {
      setProjectRoot: vi.fn(async () => undefined),
      setZoomLevel: vi.fn(async () => undefined)
    }
  };
  (window as TestWindow).api = api;
  return api;
}

function Wrapper({ children }: { children: ReactNode }): JSX.Element {
  return (
    <SettingsProvider>
      <ToastProvider>{children}</ToastProvider>
    </SettingsProvider>
  );
}

describe('settings-context', () => {
  let originalApi: unknown;

  beforeEach(() => {
    originalApi = (window as TestWindow).api;
  });

  afterEach(() => {
    cleanup();
    if (originalApi === undefined) {
      delete (window as TestWindow).api;
    } else {
      (window as TestWindow).api = originalApi;
    }
    vi.restoreAllMocks();
  });

  it('window.api.settings.load() の戻り値で settings が初期化される', async () => {
    installApi({ language: 'en', editorFontSize: 16 });

    const { result } = renderHook(() => useSettings(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.settings.language).toBe('en');
    expect(result.current.settings.editorFontSize).toBe(16);
  });

  it('update() 後 200ms の debounce 経過で window.api.settings.save() が呼ばれる', async () => {
    const api = installApi();
    const { result } = renderHook(() => useSettings(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    api.settings.save.mockClear();

    await act(async () => {
      await result.current.update({ editorFontSize: 18 });
    });
    // state は即時反映 (debounce は永続化のみ)
    expect(result.current.settings.editorFontSize).toBe(18);
    // 250ms 経過まで save 完了を待つ (debounce は 200ms)
    await waitFor(
      () => expect(api.settings.save).toHaveBeenCalledTimes(1),
      { timeout: 1500 }
    );
    expect(api.settings.save.mock.calls[0][0]).toMatchObject({ editorFontSize: 18 });
  });

  it('save が reject すると Toast が表示される (Issue #490 の昇格挙動)', async () => {
    const api = installApi(undefined, async () => {
      throw new Error('disk full');
    });
    const { result } = renderHook(() => useSettings(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.update({ editorFontSize: 20 });
    });

    // save の reject → bridgedToast → ToastProvider に届くまで実時間で待つ。
    await waitFor(() => expect(api.settings.save).toHaveBeenCalledTimes(1), {
      timeout: 1500
    });

    await waitFor(
      () => {
        const toast = document.querySelector('.toast--error');
        expect(toast).not.toBeNull();
      },
      { timeout: 1500 }
    );
  });
});

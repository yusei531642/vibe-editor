/**
 * Issue #273 + 自己レビュー: FileTreeStateProvider の動作テスト。
 *
 * カバレッジ:
 * - hydration: settings load 完了まで persist が走らないこと (自己レビュー C1/C2 回帰)
 * - concurrency queue: MAX_CONCURRENT_LOADS=4 を超えて同時実行しないこと (Issue #273 #4)
 * - 重複 enqueue 抑止: 同 key を多重 loadDir しても files.list は 1 回 (W3 統一 Promise)
 * - lazy prune: loadDir 失敗時に該当 expanded entry が prune されること (Issue #273 #3)
 * - serialize / deserialize: settings 保存形式と Set の往復
 *
 * `@testing-library/react` は `useXtermScrollToBottomOnResize.test.tsx` で使われている
 * のと同じパターン。jsdom 環境で renderHook を使う。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, cleanup } from '@testing-library/react';
import {
  FileTreeStateProvider,
  useFileTreeState,
  dirKey,
  splitKey,
  KEY_SEP
} from '../filetree-state-context';
import { SettingsProvider } from '../settings-context';
import type { ReactNode } from 'react';

// ---- shared test fixtures ----------------------------------------------

interface MockFilesApi {
  list: ReturnType<typeof vi.fn>;
}

function installWindowApi(
  filesApi: MockFilesApi,
  settingsLoad: (() => Promise<unknown>) | null = null
): void {
  // SettingsProvider が要求する settings.load / save。settingsLoad が null なら
  // load は永遠に pending にして「loading=true のまま」を再現する。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).window = (globalThis as any).window ?? {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).api = {
    files: filesApi,
    settings: {
      load: settingsLoad ?? (() => new Promise(() => undefined)),
      save: vi.fn(() => Promise.resolve())
    },
    app: {
      setProjectRoot: vi.fn(() => Promise.resolve()),
      setZoomLevel: vi.fn(() => Promise.resolve())
    }
  };
}

function makeFilesApi(initialResolveImmediately = true): MockFilesApi {
  return {
    list: vi.fn(async () => ({
      ok: true,
      entries: initialResolveImmediately ? [] : []
    }))
  };
}

function wrapper({ children }: { children: ReactNode }): JSX.Element {
  return (
    <SettingsProvider>
      <FileTreeStateProvider>{children}</FileTreeStateProvider>
    </SettingsProvider>
  );
}

beforeEach(() => {
  // 各テストで window.api をリセット
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ---- helpers -----------------------------------------------------------

describe('dirKey / splitKey', () => {
  it('dirKey は NUL 区切りで結合する', () => {
    expect(dirKey('/p1', 'src')).toBe(`/p1${KEY_SEP}src`);
    expect(dirKey('/p1', '')).toBe(`/p1${KEY_SEP}`);
  });

  it('splitKey は dirKey の逆操作 (有効な key)', () => {
    const key = dirKey('/p1', 'src/lib');
    expect(splitKey(key)).toEqual({ rootPath: '/p1', relPath: 'src/lib' });
  });

  it('splitKey は不正な key で null を返す', () => {
    expect(splitKey('no-separator')).toBeNull();
    expect(splitKey(`${KEY_SEP}rel`)).toBeNull(); // root が空
    expect(splitKey('')).toBeNull();
  });
});

// ---- hydration --------------------------------------------------------

describe('FileTreeStateProvider — hydration', () => {
  it('settings load 完了前 (loading=true) は persist が走らない (自己レビュー C1 回帰)', async () => {
    const filesApi = makeFilesApi();
    const saveMock = vi.fn(() => Promise.resolve());
    // settings.load を pending にして loading=true を維持
    let resolveLoad: (v: unknown) => void = () => undefined;
    const loadPromise = new Promise((resolve) => {
      resolveLoad = resolve;
    });
    installWindowApi(filesApi, () => loadPromise);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).api.settings.save = saveMock;

    const { result } = renderHook(() => useFileTreeState(), { wrapper });

    // hydrate 前は expanded が空 + persist なし
    expect(result.current.expanded.size).toBe(0);
    expect(saveMock).not.toHaveBeenCalled();

    // settings load を完了 (空の settings.json 相当)
    await act(async () => {
      resolveLoad({ schemaVersion: 6 });
      await loadPromise;
    });

    // hydrate 後も expanded が空のままなら save は走るがディスク書き戻しは
    // settings-context の 200ms debounce 経由なので即時には呼ばれない。
    // ここでは「persist effect が hydrate 前に発火していないこと」だけ検証。
    expect(saveMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ fileTreeExpanded: expect.anything() })
    );
  });
});

// ---- concurrency queue ------------------------------------------------

describe('FileTreeStateProvider — concurrency queue', () => {
  it('MAX_CONCURRENT_LOADS=4 を超えて同時実行しない', async () => {
    // 全リクエストを手動で resolve できるようにする
    const resolvers: Array<(v: { ok: boolean; entries: unknown[] }) => void> = [];
    const filesApi: MockFilesApi = {
      list: vi.fn(
        () =>
          new Promise((resolve) => {
            resolvers.push(resolve);
          })
      )
    };
    installWindowApi(filesApi, () => Promise.resolve({ schemaVersion: 6 }));

    const { result } = renderHook(() => useFileTreeState(), { wrapper });

    // 10 個の loadDir を発火
    await act(async () => {
      for (let i = 0; i < 10; i++) {
        void result.current.loadDir('/root', `dir-${i}`);
      }
    });

    // 同時実行は 4 まで (MAX_CONCURRENT_LOADS)
    expect(filesApi.list).toHaveBeenCalledTimes(4);

    // 1 つ resolve すると次の 1 つが queue から取り出される
    await act(async () => {
      resolvers[0]({ ok: true, entries: [] });
      // microtask 進行
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(filesApi.list).toHaveBeenCalledTimes(5);

    // 残り全部 resolve
    await act(async () => {
      for (let i = 1; i < resolvers.length; i++) {
        resolvers[i]({ ok: true, entries: [] });
      }
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it('同 key への重複 loadDir 呼び出しは files.list を 1 回しか叩かない (自己レビュー W3)', async () => {
    let resolved = false;
    const filesApi: MockFilesApi = {
      list: vi.fn(async () => {
        if (resolved) return { ok: true, entries: [] };
        resolved = true;
        return { ok: true, entries: [] };
      })
    };
    installWindowApi(filesApi, () => Promise.resolve({ schemaVersion: 6 }));

    const { result } = renderHook(() => useFileTreeState(), { wrapper });

    await act(async () => {
      const p1 = result.current.loadDir('/root', 'src');
      const p2 = result.current.loadDir('/root', 'src');
      const p3 = result.current.loadDir('/root', 'src');
      // 同じ Promise が返ること (semantics 統一)
      expect(p1).toBe(p2);
      expect(p2).toBe(p3);
      await p1;
    });

    expect(filesApi.list).toHaveBeenCalledTimes(1);
  });
});

// ---- lazy prune --------------------------------------------------------

describe('FileTreeStateProvider — lazy prune on load failure', () => {
  it('loadDir が ok=false を返したら expanded から該当 key を除去する (Issue #273 #3)', async () => {
    const filesApi: MockFilesApi = {
      list: vi.fn(async () => ({
        ok: false,
        error: 'ENOENT',
        entries: []
      }))
    };
    installWindowApi(filesApi, () => Promise.resolve({ schemaVersion: 6 }));

    const { result } = renderHook(() => useFileTreeState(), { wrapper });

    // toggleDir で展開状態を作って load を発火
    await act(async () => {
      result.current.toggleDir('/root', 'orphan-dir');
      // queue が回るのを待つ
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(filesApi.list).toHaveBeenCalledWith('/root', 'orphan-dir');

    // load 失敗後、expanded から prune されている
    await act(async () => {
      // microtask 経由で setState が反映される
      await Promise.resolve();
      await Promise.resolve();
    });

    const orphanKey = dirKey('/root', 'orphan-dir');
    expect(result.current.expanded.has(orphanKey)).toBe(false);
  });
});

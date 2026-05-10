/**
 * Issue #633: attach 経路で snapshot 〜 listener 登録の race を closing したことの回帰テスト。
 *
 * 旧設計では `terminal.create` の戻り値受領後に attach listener を張っていたため、
 * Rust 側 `scrollback_snapshot()` 取得 〜 renderer 側 listener 登録の数 ms 〜 数十 ms に
 * PTY が emit したバイトが「snapshot にも入らず listener にも届かない」状態で消えていた
 * (Codex banner / Claude welcome の欠落)。
 *
 * 本テストは use-hmr-recover を mock して wantAttach=true 経路を発火させ、
 *   1. attach 経路では `terminal.create` より**前**に `onDataReady` が呼ばれること
 *   2. pre-subscribe ターゲットが cachedPtyId と一致すること
 *   3. 戻り値の replay が term.write される (snapshot 内容の復元)
 * を検証する。1 が崩れると Issue #633 が再発する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';

// HMR cache を mock して wantAttach=true 経路を強制発火させる。
const mockCachedEntry = { ptyId: 'pty-cached-633', generation: 1 };
vi.mock('../use-hmr-recover', () => ({
  acquireGeneration: vi.fn(() => 1),
  cacheGet: vi.fn(() => mockCachedEntry),
  cacheUpsert: vi.fn(),
  cacheDelete: vi.fn(),
  hmrDisposeArmed: { current: false },
  isCurrentGeneration: vi.fn(() => true)
}));

import {
  useXtermBind,
  type PtySessionCallbacks,
  type PtySpawnSnapshot
} from '../use-xterm-bind';

type TestWindow = Window &
  typeof globalThis & {
    api?: unknown;
  };

type TestTerminal = Terminal & {
  textarea: HTMLTextAreaElement;
};

function makeRef<T>(current: T): MutableRefObject<T> {
  return { current };
}

function makeTerminal(): TestTerminal {
  const term = {
    cols: 80,
    rows: 24,
    textarea: document.createElement('textarea'),
    write: vi.fn(),
    writeln: vi.fn(),
    resize: vi.fn(),
    refresh: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() }))
  } as unknown as TestTerminal;
  return term;
}

describe('useXtermBind: Issue #633 attach 経路 pre-subscribe race fix', () => {
  let originalApi: unknown;
  let originalFontsDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalApi = (window as TestWindow).api;
    originalFontsDescriptor = Object.getOwnPropertyDescriptor(document, 'fonts');
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: Promise.resolve() } as Partial<FontFaceSet>
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    if (originalApi === undefined) {
      delete (window as TestWindow).api;
    } else {
      (window as TestWindow).api = originalApi;
    }
    if (originalFontsDescriptor) {
      Object.defineProperty(document, 'fonts', originalFontsDescriptor);
    } else {
      delete (document as Document & { fonts?: unknown }).fonts;
    }
  });

  it('attach 経路では onDataReady が terminal.create より先に呼ばれる', async () => {
    const term = makeTerminal();
    const fit = { fit: vi.fn() } as unknown as FitAddon;
    const cachedPtyId = mockCachedEntry.ptyId;

    let counter = 0;
    let createCalledAt = -1;
    let onDataReadyCalledAt = -1;
    let onDataReadyTargetId: string | null = null;

    const onDataReady = vi.fn(async (id: string) => {
      onDataReadyCalledAt = ++counter;
      onDataReadyTargetId = id;
      return vi.fn();
    });

    const create = vi.fn(async (opts: { id?: string; attachIfExists?: boolean }) => {
      createCalledAt = ++counter;
      // attach 経路: id は未指定 (Rust 側 find_attach_target が session_key から探す),
      // attachIfExists=true。
      expect(opts.attachIfExists).toBe(true);
      expect(opts.id).toBeUndefined();
      return {
        ok: true,
        id: cachedPtyId,
        attached: true,
        replay: 'banner\r\nprompt> ',
        command: 'claude'
      };
    });

    (window as TestWindow).api = {
      terminal: {
        onDataReady,
        onExitReady: vi.fn(async () => vi.fn()),
        onSessionIdReady: vi.fn(async () => vi.fn()),
        onData: vi.fn(() => vi.fn()),
        onExit: vi.fn(() => vi.fn()),
        onSessionId: vi.fn(() => vi.fn()),
        create,
        write: vi.fn(async () => undefined),
        resize: vi.fn(async () => undefined),
        kill: vi.fn(async () => undefined)
      }
    };

    const ptyIdRef = makeRef<string | null>(null);

    renderHook(() =>
      useXtermBind({
        cwd: '/tmp/work',
        command: 'claude',
        sessionKey: 'sk-633',
        termRef: makeRef<Terminal | null>(term),
        fitRef: makeRef<FitAddon | null>(fit),
        snapRef: makeRef<PtySpawnSnapshot>({}),
        callbacksRef: makeRef<PtySessionCallbacks>({}),
        ptyIdRef,
        disposedRef: makeRef(false),
        observeChunk: vi.fn(),
        unscaledFit: false
      })
    );

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(ptyIdRef.current).toBe(cachedPtyId));

    // ★ Issue #633 の core invariant: onDataReady は create より先。
    expect(onDataReadyCalledAt).toBeGreaterThan(0);
    expect(createCalledAt).toBeGreaterThan(0);
    expect(onDataReadyCalledAt).toBeLessThan(createCalledAt);

    // pre-subscribe ターゲットは cachedPtyId であること。
    expect(onDataReadyTargetId).toBe(cachedPtyId);

    // attach 経路では replay 文字列が term.write される。
    expect(term.write).toHaveBeenCalledWith('banner\r\nprompt> ');
  });

  it('attach 経路で listener 登録中に届いたバイトは queue → replay 後に flush される', async () => {
    // 「listener 登録 〜 replay 書き込み」の窓に届いた payload は queue に積まれ、
    // replay の **後** に term.write される (順序保証)。
    const term = makeTerminal();
    const fit = { fit: vi.fn() } as unknown as FitAddon;
    const cachedPtyId = mockCachedEntry.ptyId;

    let dataCallback: ((data: string) => void) | null = null;
    const onDataReady = vi.fn(async (_id: string, cb: (data: string) => void) => {
      dataCallback = cb;
      // Rust 側が PTY emit を渡してくる前に新着 byte を発火 (race window 模擬)。
      // (実装は queue モードで受け取る)。
      cb('post-snapshot-chunk-1');
      return vi.fn();
    });

    const create = vi.fn(async () => {
      // 戻り値受領前にもう 1 件 listener へ payload が届いた状況を模擬。
      if (dataCallback) {
        dataCallback('post-snapshot-chunk-2');
      }
      return {
        ok: true,
        id: cachedPtyId,
        attached: true,
        replay: '[REPLAY]',
        command: 'claude'
      };
    });

    (window as TestWindow).api = {
      terminal: {
        onDataReady,
        onExitReady: vi.fn(async () => vi.fn()),
        onSessionIdReady: vi.fn(async () => vi.fn()),
        onData: vi.fn(() => vi.fn()),
        onExit: vi.fn(() => vi.fn()),
        onSessionId: vi.fn(() => vi.fn()),
        create,
        write: vi.fn(async () => undefined),
        resize: vi.fn(async () => undefined),
        kill: vi.fn(async () => undefined)
      }
    };

    const ptyIdRef = makeRef<string | null>(null);

    renderHook(() =>
      useXtermBind({
        cwd: '/tmp/work',
        command: 'claude',
        sessionKey: 'sk-633',
        termRef: makeRef<Terminal | null>(term),
        fitRef: makeRef<FitAddon | null>(fit),
        snapRef: makeRef<PtySpawnSnapshot>({}),
        callbacksRef: makeRef<PtySessionCallbacks>({}),
        ptyIdRef,
        disposedRef: makeRef(false),
        observeChunk: vi.fn(),
        unscaledFit: false
      })
    );

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(ptyIdRef.current).toBe(cachedPtyId));

    // 期待される term.write 順:
    //   1. '[REPLAY]'  (snapshot)
    //   2. 'post-snapshot-chunk-1'  (queue 先頭, listener 登録時に受信)
    //   3. 'post-snapshot-chunk-2'  (queue 末尾, create 中に受信)
    const writeCalls = (term.write as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0]
    );
    expect(writeCalls).toEqual([
      '[REPLAY]',
      'post-snapshot-chunk-1',
      'post-snapshot-chunk-2'
    ]);
  });
});

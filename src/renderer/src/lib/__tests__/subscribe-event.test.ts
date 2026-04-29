/**
 * Issue #294: `subscribeEvent` / `subscribeEventReady` のユニットテスト。
 *
 * 検証する race:
 * - await pending 中に caller が dispose したら listener が orphan にならない
 * - await 解決後に dispose したら正しく unlisten される
 * - payload が複数到着しても disposed 後は cb を呼ばない
 * - subscribeEvent (sync ラッパ) も同等の挙動を持つ
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `@tauri-apps/api/event` の `listen` を mock する。resolve タイミングを
// テストごとに制御するため、deferred を返す形にする。
type Listener<T> = (e: { payload: T }) => void;
let pendingListens: Array<{
  event: string;
  listener: Listener<unknown>;
  resolve: (unlisten: () => void) => void;
}>;
let unlistenCalls: number;

vi.mock('@tauri-apps/api/event', () => {
  return {
    listen: vi.fn(<T>(event: string, listener: Listener<T>) => {
      return new Promise<() => void>((resolve) => {
        pendingListens.push({
          event,
          listener: listener as Listener<unknown>,
          resolve: (unlisten) => resolve(unlisten),
        });
      });
    }),
  };
});

// mock を立ててから import (vitest はホイストするので import 順は問題ない)
import { subscribeEvent, subscribeEventReady } from '../subscribe-event';

beforeEach(() => {
  pendingListens = [];
  unlistenCalls = 0;
});

afterEach(() => {
  pendingListens = [];
});

/** mock listen() を resolve させて、生きた listener と unlisten を返す。 */
function resolvePendingListen(index = 0): { listener: Listener<unknown> } {
  const pending = pendingListens[index];
  if (!pending) throw new Error(`no pending listen at index ${index}`);
  const unlisten = () => {
    unlistenCalls += 1;
  };
  pending.resolve(unlisten);
  return { listener: pending.listener };
}

describe('subscribeEventReady (Issue #294)', () => {
  it('listener 登録完了後に payload が cb に届く', async () => {
    const cb = vi.fn();
    const cleanupPromise = subscribeEventReady<string>('test:event', cb);
    // 解決前は listener が呼ばれない (pending)。
    expect(cb).not.toHaveBeenCalled();
    const { listener } = resolvePendingListen();
    const cleanup = await cleanupPromise;
    listener({ payload: 'hello' });
    expect(cb).toHaveBeenCalledWith('hello');
    cleanup();
  });

  it('cleanup 後に届いた payload は cb に届かない (disposed sentinel)', async () => {
    const cb = vi.fn();
    const cleanupPromise = subscribeEventReady<string>('test:event', cb);
    const { listener } = resolvePendingListen();
    const cleanup = await cleanupPromise;
    listener({ payload: 'before-cleanup' });
    cleanup();
    listener({ payload: 'after-cleanup' });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('before-cleanup');
    expect(unlistenCalls).toBe(1);
  });

  it('複数 payload が連続到着しても disposed 後は cb を呼ばない', async () => {
    const cb = vi.fn();
    const cleanupPromise = subscribeEventReady<number>('test:event', cb);
    const { listener } = resolvePendingListen();
    const cleanup = await cleanupPromise;
    for (let i = 0; i < 3; i += 1) listener({ payload: i });
    cleanup();
    for (let i = 3; i < 6; i += 1) listener({ payload: i });
    expect(cb).toHaveBeenCalledTimes(3);
    expect(cb.mock.calls.map((c) => c[0])).toEqual([0, 1, 2]);
  });

  // 注: subscribeEventReady 単体では「await pending 中に dispose する手段」を持たない
  // (cleanup 関数を caller が受け取ってからしか disposed フラグを立てられない設計)。
  // pending 中の dispose ガードは caller (使用例: use-pty-session.ts の disposedRef) の責務。
  // subscribeEvent (sync ラッパ) には pending 中 dispose のガードがあり、下のテストで検証する。
});

describe('subscribeEvent (sync ラッパ, Issue #294)', () => {
  it('listen() pending 中に caller が dispose しても listener は orphan にならない', async () => {
    const cb = vi.fn();
    const cleanup = subscribeEvent<string>('test:event', cb);
    // listen() が resolve する前に caller が dispose
    cleanup();
    // listen() が resolve してから、即時 unlisten が呼ばれる (deferred unlisten)
    resolvePendingListen();
    // micro-task を消化させる
    await Promise.resolve();
    await Promise.resolve();
    expect(unlistenCalls).toBe(1);
    expect(cb).not.toHaveBeenCalled();
  });

  it('await 解決後に dispose したら unlisten が呼ばれる', async () => {
    const cb = vi.fn();
    const cleanup = subscribeEvent<string>('test:event', cb);
    const { listener } = resolvePendingListen();
    // subscribeEvent 内部の subscribeEventReady().then(u => ...) を消化
    await Promise.resolve();
    await Promise.resolve();
    listener({ payload: 'hello' });
    expect(cb).toHaveBeenCalledWith('hello');
    cleanup();
    expect(unlistenCalls).toBe(1);
    // dispose 後の payload は届かない
    listener({ payload: 'after' });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('cleanup を 2 回呼んでも unlisten は 1 回だけ走る (idempotent dispose)', async () => {
    const cb = vi.fn();
    const cleanup = subscribeEvent<string>('test:event', cb);
    resolvePendingListen();
    await Promise.resolve();
    await Promise.resolve();
    cleanup();
    cleanup();
    expect(unlistenCalls).toBe(1);
    expect(cb).not.toHaveBeenCalled();
  });
});

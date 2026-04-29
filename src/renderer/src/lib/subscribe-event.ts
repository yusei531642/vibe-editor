/**
 * Tauri event 購読ヘルパ (Issue #294)。
 *
 * `@tauri-apps/api/event` の `listen()` は Promise<UnlistenFn> を返すため、
 * caller が cleanup を同期的に欲しい場合や、初期出力 race を避けるために
 * 「listener 登録完了」を await したい場合の橋渡しを行う。
 *
 * Issue #285 / PR #291 で導入した pre-subscribe パターンの内部実装をここに集約し、
 * 同型 race を構造的に再生産しない方針 (Issue #294 の subscribe API 統一)。
 */

import { listen } from '@tauri-apps/api/event';

/**
 * Issue #285: `listen()` の解決を await することで「listener が確実に登録された」
 * 状態を caller に保証する async API。`terminal_create` を呼ぶ前に pre-subscribe
 * して、PTY の初期出力 (CLI banner / prompt) が listener 未登録の数十 ms に
 * drop されるレースを排除するために使う。
 *
 * 内部実装は `disposed` sentinel を持ち、caller が cleanup を呼んだ以降の payload は
 * cb に届かない (deferred unlisten 同等)。
 *
 * **Caller の責務**: await が pending の間に component が dispose される race を避けるため、
 * await 解決直後に caller 側で disposed flag を再判定し、必要なら戻り値の cleanup を即呼ぶ。
 * 本 helper の `disposed` sentinel は cleanup 関数を caller が受け取ってからしか立てられず、
 * await pending 中の listen() 完了を取り消せないため、caller 側ガードが必須。
 *
 * 参考実装: `use-pty-session.ts` の pre-subscribe ブロック
 *   `offData = await ...onDataReady(...);`
 *   `if (localDisposed || disposedRef.current) { unsubscribePtyListeners(); return; }`
 */
export async function subscribeEventReady<T>(
  event: string,
  cb: (payload: T) => void
): Promise<() => void> {
  let disposed = false;
  const unlisten = await listen<T>(event, (e) => {
    if (!disposed) cb(e.payload);
  });
  return () => {
    disposed = true;
    unlisten();
  };
}

/**
 * `subscribeEventReady` の sync ラッパ (Issue #294)。caller が「cleanup を同期的に
 * 受け取りたい」場合のための薄いラッパで、内部は `subscribeEventReady` を呼ぶ。
 *
 * 旧実装は `void listen().then(u => ...)` で fire-and-forget しつつ、resolve 前の
 * cleanup を deferred unlisten で扱っていた。挙動は同じだが、async 版を経由する
 * ことで「await 解決前後の disposed sentinel」のロジックが 1 箇所に集約され、
 * Issue #285 と同型の race を構造的に再生産しないことが保証される。
 *
 * 注: 同期 API のため「listener が登録された瞬間」を caller は知れない。Rust 側 emit が
 * 数十 ms 〜 数百 ms 早く走るとそのデータは drop される (Issue #285 の元症状)。確実な購読
 * 完了を待ちたい場合は `subscribeEventReady` (async 版) を使うこと。
 */
export function subscribeEvent<T>(
  event: string,
  cb: (payload: T) => void
): () => void {
  let earlyDisposed = false;
  let cleanup: (() => void) | null = null;
  void subscribeEventReady<T>(event, cb).then((u) => {
    if (earlyDisposed) {
      // 早期 cleanup: caller が listen() 解決前に dispose 済 → 即 unlisten。
      u();
    } else {
      cleanup = u;
    }
  });
  return () => {
    earlyDisposed = true;
    cleanup?.();
    cleanup = null;
  };
}

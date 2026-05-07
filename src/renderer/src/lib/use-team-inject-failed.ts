/**
 * Issue #511: Rust TeamHub の `team:inject_failed` event を Canvas 側で集約して購読するフック。
 *
 * `use-team-handoff.ts` と同じ Issue #158 / #192 パターンに揃えてある:
 *  - Tauri の `listen()` は全フック共通で **1 本だけ** 張る (subscriber 0 になったら unsubscribe)。
 *  - 個別の購読者は in-memory `Set<Listener>` 経由で broadcast を受ける。
 *  - `initPromise` をそのまま握って resolve まで unlisten を遅延し、cleanup 中再マウント race を解消する。
 *
 * `team:inject_failed` は `team_send` または `team_send_retry_inject` が PTY inject に失敗した瞬間
 * に Hub 側から emit される。post-subscribe race は構造的に発生しない (send 後にしか来ない) ので
 * `subscribeEventReady` を使う必要は無く、`listen()` の同期登録で十分。
 */
import { useEffect, useRef } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { TeamInjectFailedEvent } from '../../../../types/shared';

type Listener = (p: TeamInjectFailedEvent) => void;
const listeners = new Set<Listener>();
let initPromise: Promise<UnlistenFn> | null = null;

function ensureRegistered(): Promise<UnlistenFn> {
  if (initPromise) return initPromise;
  const p = listen<TeamInjectFailedEvent>('team:inject_failed', (e) => {
    for (const cb of listeners) {
      try {
        cb(e.payload);
      } catch (err) {
        console.warn('[inject-failed] listener threw:', err);
      }
    }
  });
  initPromise = p;
  // listen() が reject した場合に initPromise を rejected で固着させない (use-team-handoff.ts と同方針)。
  p.catch(() => {
    if (initPromise === p) initPromise = null;
  });
  return p;
}

/**
 * `team:inject_failed` を購読する React フック。Tauri listen は全フック共通で 1 本だけ。
 * subscriber 0 になった時点で Tauri listen を unsubscribe する。
 */
export function useTeamInjectFailed(callback: (p: TeamInjectFailedEvent) => void): void {
  const cbRef = useRef(callback);
  cbRef.current = callback;

  useEffect(() => {
    const wrapper: Listener = (p) => cbRef.current(p);
    listeners.add(wrapper);
    const myInit = ensureRegistered();
    return () => {
      listeners.delete(wrapper);
      if (listeners.size !== 0) return;
      // resolve を待ってから unlisten を呼ぶ (use-team-handoff の Issue #192 race と同じ対策)。
      void myInit
        .then((u) => {
          if (listeners.size > 0) return;
          u();
          if (initPromise === myInit) initPromise = null;
        })
        .catch((err) => {
          console.warn('[inject-failed] listen() failed in cleanup path:', err);
        });
    };
  }, []);
}

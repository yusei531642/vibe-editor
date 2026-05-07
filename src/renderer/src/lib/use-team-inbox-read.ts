/**
 * Issue #509: Rust TeamHub の `team:inbox_read` event を Canvas 側で集約して購読するフック。
 *
 * `use-team-handoff.ts` / `use-team-inject-failed.ts` と同じ Issue #158 / #192 パターンに揃える:
 *  - Tauri の `listen()` は全フック共通で **1 本だけ** 張る (subscriber 0 になったら unsubscribe)。
 *  - 個別の購読者は in-memory `Set<Listener>` 経由で broadcast を受ける。
 *  - `initPromise` をそのまま握って resolve まで unlisten を遅延し、cleanup 中再マウント race を解消する。
 *
 * `team:inbox_read` は `team_read` が **新しく** read_by に追加した瞬間にしか emit されない
 * (= 既読 message の再 read では event が来ない)。post-subscribe race は構造的に発生しない
 * (read は send 後にしか起きない) ので `subscribeEventReady` を使う必要は無い。
 */
import { useEffect, useRef } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { TeamInboxReadEvent } from '../../../../types/shared';

type Listener = (p: TeamInboxReadEvent) => void;
const listeners = new Set<Listener>();
let initPromise: Promise<UnlistenFn> | null = null;

function ensureRegistered(): Promise<UnlistenFn> {
  if (initPromise) return initPromise;
  const p = listen<TeamInboxReadEvent>('team:inbox_read', (e) => {
    for (const cb of listeners) {
      try {
        cb(e.payload);
      } catch (err) {
        console.warn('[inbox-read] listener threw:', err);
      }
    }
  });
  initPromise = p;
  p.catch(() => {
    if (initPromise === p) initPromise = null;
  });
  return p;
}

/**
 * `team:inbox_read` を購読する React フック。Tauri listen は全フック共通で 1 本だけ。
 * subscriber 0 になった時点で Tauri listen を unsubscribe する。
 */
export function useTeamInboxRead(callback: (p: TeamInboxReadEvent) => void): void {
  const cbRef = useRef(callback);
  cbRef.current = callback;

  useEffect(() => {
    const wrapper: Listener = (p) => cbRef.current(p);
    listeners.add(wrapper);
    const myInit = ensureRegistered();
    return () => {
      listeners.delete(wrapper);
      if (listeners.size !== 0) return;
      void myInit
        .then((u) => {
          if (listeners.size > 0) return;
          u();
          if (initPromise === myInit) initPromise = null;
        })
        .catch((err) => {
          console.warn('[inbox-read] listen() failed in cleanup path:', err);
        });
    };
  }, []);
}

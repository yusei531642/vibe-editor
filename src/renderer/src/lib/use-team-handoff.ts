import { useEffect, useRef } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/**
 * Issue #158: Rust TeamHub の `team:handoff` イベントは Canvas と ActivityFeed の
 * 両方が listen しており、同じイベントに対して 2 つの Tauri リスナーが並ぶ構造になっていた。
 * 将来カウントロジック等で重複事故を起こさないよう、Tauri 側の listen を 1 本にまとめ、
 * 各購読者は in-memory の Set 経由で broadcast を受け取る方式に変更する。
 */

export interface HandoffPayload {
  teamId: string;
  fromAgentId: string;
  fromRole: string;
  toAgentId: string;
  toRole: string;
  preview: string;
  messageId: number;
  timestamp?: string;
}

type Listener = (p: HandoffPayload) => void;
const listeners = new Set<Listener>();
/**
 * Issue #192: 旧実装は `unlisten` を別変数に保持し、`listen()` の resolve を待たずに
 * cleanup が走ると「resolve 後に届く unlisten が誰からも呼ばれない孤児」になり、
 * 次のマウントで `initPromise === null` を見て 2 本目の listen が張られて二重発火していた。
 * 修正: Promise 自体に UnlistenFn を持たせ、cleanup は必ず resolve を待ってから unlisten を呼ぶ。
 */
let initPromise: Promise<UnlistenFn> | null = null;

function ensureRegistered(): Promise<UnlistenFn> {
  if (initPromise) return initPromise;
  initPromise = listen<HandoffPayload>('team:handoff', (e) => {
    for (const cb of listeners) {
      try {
        cb(e.payload);
      } catch (err) {
        console.warn('[handoff] listener threw:', err);
      }
    }
  });
  return initPromise;
}

/**
 * `team:handoff` を購読する React フック。Tauri listen は全 hook 共通で 1 本だけ。
 * subscriber 0 になった時点で Tauri listen を unsubscribe する。
 */
export function useTeamHandoff(callback: (p: HandoffPayload) => void): void {
  const cbRef = useRef(callback);
  cbRef.current = callback;

  useEffect(() => {
    const wrapper: Listener = (p) => cbRef.current(p);
    listeners.add(wrapper);
    const myInit = ensureRegistered();
    return () => {
      listeners.delete(wrapper);
      if (listeners.size !== 0) return;
      // 全 subscriber が抜けた → Tauri listener を止めて initPromise をリセット。
      // listen() がまだ resolve していなくても、Promise.then で resolve 後に呼ぶことで
      // 「unlisten が孤児になり次マウントで二重 listen」 (Issue #192) を防ぐ。
      // ただし then 内で listeners.size を再確認し、別フックが先に再 mount していれば
      // unlisten せずにそのまま使い回す (false-positive cleanup を避ける)。
      const stale = initPromise;
      initPromise = null;
      void myInit.then((u) => {
        if (listeners.size > 0 && initPromise === null) {
          // 再マウントが間に合った: この listen をそのまま再活用する
          initPromise = stale;
        } else {
          u();
        }
      });
    };
  }, []);
}

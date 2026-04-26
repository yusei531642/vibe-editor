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
let unlisten: UnlistenFn | null = null;
let initPromise: Promise<void> | null = null;

function ensureRegistered(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = listen<HandoffPayload>('team:handoff', (e) => {
    for (const cb of listeners) {
      try {
        cb(e.payload);
      } catch (err) {
        console.warn('[handoff] listener threw:', err);
      }
    }
  }).then((u) => {
    unlisten = u;
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
    void ensureRegistered();
    return () => {
      listeners.delete(wrapper);
      // すべての subscriber が抜けたら Tauri listener も止める。
      if (listeners.size === 0) {
        const u = unlisten;
        unlisten = null;
        initPromise = null;
        if (u) u();
      }
    };
  }, []);
}

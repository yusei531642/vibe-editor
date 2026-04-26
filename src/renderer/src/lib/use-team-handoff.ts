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
      // Issue #192: cleanup 時点で listeners=0 でも、unlisten 完了前に再マウントが間に合うと
      // 「古い initPromise を即 null → 新マウントが NEW listen を生成 → 古い listen は
      //  まだ生きていて二重発火」となる race があるため、resolve まで initPromise を null に
      // しない。resolve 時に listeners.size を再確認し、
      //   - 0 のまま: 本当に誰も居ない → u() で unlisten + initPromise クリア
      //   - >0     : 再マウントが間に合った → 既存 listen を再利用 (initPromise=myInit のまま)
      // どちらの分岐でも listen は 1 本だけ、二重発火しない。
      //
      // 詳細な race シナリオ (レビュー検証用):
      //   t0: マウント A cleanup → listeners.delete(wrapperA) → listeners.size = 0
      //   t1: ensureRegistered() を呼んでいたマウント B が listeners.add(wrapperB) → size = 1
      //       B の myInit は ensureRegistered の if (initPromise) return initPromise で
      //       同じ Promise (= A の myInit) を取得済み
      //   t2: A の cleanup .then が resolve → listeners.size > 0 → return (unlisten せず)
      //   t3: B の cleanup → listeners.size = 0
      //   t4: B の cleanup .then が resolve → listeners.size = 0 → u() で unlisten
      //       initPromise === myInit (B) なので null クリア
      // listen は 1 本だけ、unlisten も 1 回だけ。リークなし。
      void myInit
        .then((u) => {
          if (listeners.size > 0) return;
          u();
          if (initPromise === myInit) initPromise = null;
        })
        .catch((err) => {
          // 旧コードは catch を空に握り潰していたが、Tauri IPC が壊れた等で listen() が
          // 失敗したケースが完全に sile になってしまうため最低限 console.warn で残す。
          console.warn('[handoff] listen() failed in cleanup path:', err);
        });
    };
  }, []);
}

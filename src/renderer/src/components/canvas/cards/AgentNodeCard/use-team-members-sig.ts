/**
 * AgentNodeCard / useTeamMembersSig
 *
 * Issue #735: 旧 `CardFrame.tsx` は同 teamId のメンバー roster を
 * `useCanvasStore((s) => { ...; lastTeamMembersSigRef.current = sig; return sig; })`
 * という形で購読しており、**zustand selector callback の中で ref を mutate** していた。
 * selector は pure であることが前提 (zustand が equality bailout のため任意回数呼ぶ /
 * StrictMode で二重実行する) なので、これは前提違反だった。
 *
 * 修正方針: signature 計算を `useSyncExternalStore` に移す。
 *   - `getSnapshot` は「キャッシュ済みの安定値を返す」のが React 公式の規定動作。
 *     同じ内容なら同一文字列を返すので useSyncExternalStore は再レンダーを bailout する。
 *   - drag 中は roster (agentId:role:agent) が変わらないため signature も不変。
 *     旧実装と同じく drag 中は O(N) ループをスキップしてキャッシュ値を返す
 *     (これは「未変更なのでキャッシュを返す」= getSnapshot の正しい使い方)。
 *
 * これにより zustand に渡る selector は廃止され、pure 違反が解消する。
 */
import { useCallback, useRef, useSyncExternalStore } from 'react';
import { useCanvasStore, agentPayloadOf } from '../../../../stores/canvas';

/**
 * 同 teamId の agent カード群から `agentId:roleProfileId:agent` を `;` 連結した
 * primitive signature を計算する。`teamId` が無ければ空文字。
 *
 * 旧 `CardFrame.tsx` の selector 内ループと完全に同一ロジック (挙動不変)。
 */
function computeTeamMembersSig(
  nodes: ReturnType<typeof useCanvasStore.getState>['nodes'],
  teamId: string
): string {
  const sigs: string[] = [];
  for (const n of nodes) {
    if (n.type !== 'agent') continue;
    const p = agentPayloadOf(n.data);
    const rp = p?.roleProfileId ?? p?.role;
    if (!p || p.teamId !== teamId || !p.agentId || !rp) continue;
    sigs.push(`${p.agentId}:${rp}:${p.agent ?? 'claude'}`);
  }
  return sigs.join(';');
}

/**
 * 同 teamId のメンバー roster を表す primitive signature を購読する hook。
 *
 * - `teamId` が undefined のときは常に空文字を返す。
 * - drag 中 (`isDragging`) は roster 不変なので直前の signature をそのまま返し、
 *   毎フレームの O(N) 走査を避ける (旧 CardFrame のキャッシュ最適化を踏襲)。
 * - 戻り値は文字列なので、内容が同じなら useSyncExternalStore が再レンダーを bailout する。
 */
export function useTeamMembersSig(teamId: string | undefined): string {
  // getSnapshot が返す「安定値」のキャッシュ。useSyncExternalStore の規定どおり、
  // 内容が変わらない限り同一文字列を返すことで不要な再レンダーを防ぐ。
  const cacheRef = useRef('');
  const getSnapshot = useCallback((): string => {
    if (!teamId) {
      cacheRef.current = '';
      return '';
    }
    const s = useCanvasStore.getState();
    // drag 中は roster 不変。直前 signature をそのまま返す (= 未変更キャッシュ返却)。
    if (s.isDragging) return cacheRef.current;
    const sig = computeTeamMembersSig(s.nodes, teamId);
    cacheRef.current = sig;
    return sig;
  }, [teamId]);
  return useSyncExternalStore(useCanvasStore.subscribe, getSnapshot, getSnapshot);
}

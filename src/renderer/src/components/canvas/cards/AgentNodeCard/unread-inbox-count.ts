/**
 * Issue #596: AgentNodeCard の `unreadInboxCount` 加減算ロジック (closure stale race fix)。
 *
 * 旧実装は `useCallback` の closure で `payload.unreadInboxCount` を読んでから
 * `setCardPayload` で書き戻していたため、1 frame (16ms) 以内に同じ agentId へ
 * 複数 `team:handoff` / `team:inbox_read` が連投されると、両 callback が
 * **stale な closure 値** (= まだ React commit 前の payload) を base に書き、
 * 最終 `unreadInboxCount` が undercount する race があった (CRITICAL bug)。
 *
 * 修正: callback 内で zustand `useCanvasStore.getState()` を毎回叩いて
 * **callback 実行時点の最新 payload** を直読みする。zustand の `set` は同期反映
 * なので、同 tick で 2 回呼んでも 2 回目は 1 回目の結果を見て +1 できる。
 *
 * 本ファイルは React tree から切り離して unit test できるよう store API を
 * 引数で受ける形にしている (CardFrame 本体は `useCanvasStore` をそのまま渡す)。
 */

import type { HandoffPayload } from '../../../../lib/use-team-handoff';
import type { TeamInboxReadEvent } from '../../../../../../types/shared';
import { useCanvasStore, agentPayloadOf } from '../../../../stores/canvas';
import type { AgentPayload } from './types';

/** test と本体で `useCanvasStore` を共有するための型 alias。 */
export type CanvasStoreApi = typeof useCanvasStore;

function readLatestPayload(store: CanvasStoreApi, id: string): AgentPayload {
  const node = store.getState().nodes.find((n) => n.id === id);
  // Issue #732: 旧 `node?.data?.payload as AgentPayload` を agentPayloadOf に置換。
  return agentPayloadOf(node?.data) ?? {};
}

/**
 * `team:handoff` が **自分宛** だった場合に unreadInboxCount を +1 する。
 *
 * @returns 自分宛で更新したら true、対象外なら false (caller 側で副作用判定したい場合用)。
 */
export function applyHandoffArrival(
  store: CanvasStoreApi,
  id: string,
  evt: Pick<HandoffPayload, 'toAgentId' | 'timestamp'>,
  expectedAgentId: string | undefined
): boolean {
  if (!expectedAgentId || evt.toAgentId !== expectedAgentId) return false;
  const latest = readLatestPayload(store, id);
  const prevCount = latest.unreadInboxCount ?? 0;
  // 既存 oldestUnreadDeliveredAt は維持。新着分は最新側なので「一番古い」を残す観点では
  // 既存 (= より古い) 値を尊重し、未設定 (count=0 → 1) のときだけ初期化する。
  const oldest = latest.oldestUnreadDeliveredAt ?? evt.timestamp;
  store.getState().setCardPayload(id, {
    unreadInboxCount: prevCount + 1,
    oldestUnreadDeliveredAt: oldest
  });
  return true;
}

/**
 * `team:inbox_read` が **自分による既読** だった場合に unreadInboxCount を減算する。
 *
 * @returns 自分の read だったら true、他人の read なら false。
 */
export function applyInboxRead(
  store: CanvasStoreApi,
  id: string,
  evt: Pick<TeamInboxReadEvent, 'readByAgentId' | 'messageIds'>,
  expectedAgentId: string | undefined
): boolean {
  if (!expectedAgentId || evt.readByAgentId !== expectedAgentId) return false;
  const latest = readLatestPayload(store, id);
  const prevCount = latest.unreadInboxCount ?? 0;
  const next = Math.max(0, prevCount - evt.messageIds.length);
  // 全件読了なら oldestUnreadDeliveredAt も undefined にして clean state に戻す。
  // 部分既読のときは oldest を維持 (本当の oldest 推定には messageIds と
  // delivered_at の照合が必要だが、event-driven 集計では粗い近似で十分)。
  store.getState().setCardPayload(id, {
    unreadInboxCount: next,
    oldestUnreadDeliveredAt: next === 0 ? undefined : latest.oldestUnreadDeliveredAt
  });
  return true;
}

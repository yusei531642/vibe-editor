/**
 * チームカード × 押下時に「同チームの全員が一緒に閉じます。続行しますか？」を確認するフック。
 *
 * 背景:
 *   `useCanvasStore.removeCard(id)` は teamId が一致する全カードをまとめて閉じる仕様
 *   (canvas.ts:122-)。Leader 1 枚閉じたつもりが HR / 動的ワーカー全員消える事故を防ぐため、
 *   ユーザー操作 (× / 右クリック / Delete) からの呼び出しは必ずこのラッパー経由にする。
 *   採用リスナー (use-recruit-listener) など内部処理は store.removeCard を直接使ってよい。
 */
import { useCallback } from 'react';
import { useCanvasStore } from '../stores/canvas';
import { useT } from './i18n';

export function useConfirmRemoveCard(): (id: string) => void {
  const t = useT();
  return useCallback(
    (id: string) => {
      const state = useCanvasStore.getState();
      const target = state.nodes.find((n) => n.id === id);
      const teamId = (target?.data?.payload as { teamId?: string } | undefined)?.teamId;
      if (teamId) {
        const teamMembers = state.nodes.filter((n) => {
          const tid = (n.data?.payload as { teamId?: string } | undefined)?.teamId;
          return tid === teamId;
        });
        if (teamMembers.length > 1) {
          // チーム名は payload.teamName / data.title から拾う (どちらかが入っていれば良い)。
          const teamName =
            (target?.data?.payload as { teamName?: string } | undefined)?.teamName ??
            teamId;
          const ok = window.confirm(
            t('agentCard.confirmCloseTeam', {
              count: teamMembers.length,
              name: teamName
            })
          );
          if (!ok) return;
        }
      }
      state.removeCard(id);
    },
    [t]
  );
}

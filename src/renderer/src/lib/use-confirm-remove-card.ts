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
import { confirmAsync } from './tauri-api';

export function useConfirmRemoveCard(): (id: string) => void {
  const t = useT();
  return useCallback(
    (id: string) => {
      // Tauri WebView は window.confirm() を直接使えない (`dialog.confirm not allowed`)。
      // confirmAsync はネイティブ ask ダイアログを async で出すため、IIFE で包んで
      // 呼び出し側 (右クリック / × / Delete キー) は引き続き同期的に呼べるように見せる。
      void (async () => {
        const state = useCanvasStore.getState();
        const target = state.nodes.find((n) => n.id === id);
        const teamId = (target?.data?.payload as { teamId?: string } | undefined)?.teamId;
        if (teamId) {
          const teamMembers = state.nodes.filter((n) => {
            const tid = (n.data?.payload as { teamId?: string } | undefined)?.teamId;
            return tid === teamId;
          });
          if (teamMembers.length > 1) {
            const teamName =
              (target?.data?.payload as { teamName?: string } | undefined)?.teamName ?? teamId;
            const ok = await confirmAsync(
              t('agentCard.confirmCloseTeam', {
                count: teamMembers.length,
                name: teamName
              })
            );
            if (!ok) return;
          }
        }
        state.removeCard(id);
      })();
    },
    [t]
  );
}

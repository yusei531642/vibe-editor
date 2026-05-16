/**
 * チームカード × 押下時に「同チームの全員が一緒に閉じます。続行しますか？」を確認するフック。
 *
 * 背景:
 *   `useCanvasStore.removeCard(id)` は teamId が一致する全カードをまとめて閉じる仕様
 *   (canvas.ts:122-)。Leader 1 枚閉じたつもりが HR / 動的ワーカー全員消える事故を防ぐため、
 *   ユーザー操作 (× / 右クリック / Delete) からの呼び出しは必ずこのラッパー経由にする。
 *   採用リスナー (use-recruit-listener) など内部処理は store.removeCard を直接使ってよい。
 *
 * Issue #595: EditorCard の未保存編集が × / Clear で confirm 無く飛ぶ data-loss を塞ぐため、
 *   削除対象 (cascadeTeam で広がる ids も含めて) の中に dirty editor が居れば追加 confirm
 *   を出す。dirty 検出は editor-card-dirty-registry が一元管理する。
 */
import { useCallback } from 'react';
import { useCanvasStore, cardTeamId, cardTeamName } from '../stores/canvas';
import { useT } from './i18n';
import { getDirtyEditorCardSnapshots } from './editor-card-dirty-registry';

export function useConfirmRemoveCard(): (id: string) => void {
  const t = useT();
  return useCallback(
    (id: string) => {
      const state = useCanvasStore.getState();
      const target = state.nodes.find((n) => n.id === id);
      // Issue #732: teamId / teamName 抽出は判別可能 union を見る共通 helper に集約
      // (旧 `payload as { teamId? } / { teamName? }` 局所キャストを撤去)。
      const teamId = cardTeamId(target?.data);
      // store.removeCard と同じ「cascadeTeam=true」の動きで削除対象 id 集合を作る。
      // editor dirty チェックはこの集合全体に対して行う。
      const idsToRemove = new Set<string>([id]);
      if (teamId) {
        for (const n of state.nodes) {
          const tid = cardTeamId(n.data);
          if (tid === teamId) idsToRemove.add(n.id);
        }
      }
      // ---- 1) チーム cascade confirm (既存仕様) ----
      if (teamId && idsToRemove.size > 1) {
        const teamName = cardTeamName(target?.data) ?? teamId;
        const ok = window.confirm(
          t('agentCard.confirmCloseTeam', {
            count: idsToRemove.size,
            name: teamName
          })
        );
        if (!ok) return;
      }
      // ---- 2) editor dirty confirm (Issue #595) ----
      const dirty = getDirtyEditorCardSnapshots(idsToRemove);
      if (dirty.length === 1) {
        const ok = window.confirm(
          t('editor.confirmDiscardChanges', { path: dirty[0].relPath })
        );
        if (!ok) return;
      } else if (dirty.length > 1) {
        const paths = dirty.map((d) => `• ${d.relPath}`).join('\n');
        const ok = window.confirm(
          t('editor.confirmDiscardChangesPlural', { count: dirty.length, paths })
        );
        if (!ok) return;
      }
      state.removeCard(id);
    },
    [t]
  );
}

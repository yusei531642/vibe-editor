import { useEffect, useState } from 'react';

/**
 * Issue #387: Rail の History ボタンのバッジを「履歴総件数」ではなく
 * 「未確認件数」として表示するための hook。
 *
 * 仕様:
 * - 履歴パネル表示中は常に baseline = totalCount として扱い、バッジは 0。
 * - 表示中に新規履歴が増えても、追従して 0 のまま。
 * - 履歴を閉じたあとに新規履歴が増えたら、増分のみをバッジに表示する。
 * - totalCount が減っても負数にならず 0 に clamp する。
 *
 * 永続化はしない (process 内 in-memory のみ)。再起動後の確認済み持続は別 issue。
 */
export function useHistoryBadgeCount(
  totalCount: number,
  isHistoryVisible: boolean
): number {
  const [seenCount, setSeenCount] = useState(0);

  useEffect(() => {
    if (isHistoryVisible) {
      setSeenCount(totalCount);
    }
  }, [isHistoryVisible, totalCount]);

  const baseline = isHistoryVisible ? totalCount : seenCount;
  return Math.max(0, totalCount - baseline);
}

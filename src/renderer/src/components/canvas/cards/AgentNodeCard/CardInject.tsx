/**
 * AgentNodeCard / CardInject
 *
 * Issue #735: 旧 `CardFrame.tsx` (~900 行 god card) から「PTY inject 失敗の
 * 警告 row + 手動リトライ UI」(Issue #511) を切り出した子コンポーネント。
 *
 * `team_send` (またはリトライ後の `team_send_retry_inject`) が PTY inject に失敗した
 * 瞬間、Hub から `team:inject_failed` event が emit される。Canvas 側はそれを受けて
 * 該当 agent の payload.lastInjectFailure に reason を書き込み、本コンポーネントが
 * warning row を render する。retry button で `window.api.team.retryInject` を呼び、
 * 成功すれば payload.lastInjectFailure を undefined クリアして warning を消す。
 *
 * 挙動・DOM・クラス名は元 `.canvas-agent-card__inject-warning` ブロックと完全一致。
 * inject 失敗 event の購読 (useTeamInjectFailed) も含めて本コンポーネントに閉じる
 * (payload.lastInjectFailure が無いときは何も render しない)。
 */
import { useCallback, useState } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { useTeamInjectFailed } from '../../../../lib/use-team-inject-failed';
import type { useToast } from '../../../../lib/toast-context';
import type { AgentPayload } from './types';

/** i18n の `t` 関数シグネチャ。 */
type TFn = (key: string, params?: Record<string, string | number>) => string;

/** CardFrame から渡される `showToast` (useToast の戻り値そのまま)。 */
type ShowToastFn = ReturnType<typeof useToast>['showToast'];

interface CardInjectProps {
  /** Canvas ノード id。setCardPayload の対象。 */
  cardId: string;
  /** agent payload (lastInjectFailure / teamId / agentId を読む)。 */
  payload: AgentPayload;
  /** canvas store の setCardPayload (payload 浅マージ)。 */
  setCardPayload: (id: string, patch: Record<string, unknown>) => void;
  showToast: ShowToastFn;
  t: TFn;
}

/**
 * Issue #735: 旧 CardFrame の inject 失敗 warning row。
 *
 * `team:inject_failed` event の購読・retry IPC・dismiss をすべて内包する。
 * `payload.lastInjectFailure` が無い間は `null` を返す (= 通常時は不可視)。
 */
export function CardInject({
  cardId,
  payload,
  setCardPayload,
  showToast,
  t
}: CardInjectProps): JSX.Element | null {
  const [retryBusy, setRetryBusy] = useState(false);

  // `team:inject_failed` を受けたら自カード宛のものだけ payload.lastInjectFailure へ書き込む。
  useTeamInjectFailed(
    useCallback(
      (evt) => {
        if (!payload.agentId || evt.toAgentId !== payload.agentId) return;
        setCardPayload(cardId, {
          lastInjectFailure: {
            messageId: evt.messageId,
            reason: { code: evt.reasonCode, message: evt.reasonMessage },
            failedAt: evt.failedAt,
            fromRole: evt.fromRole
          }
        });
      },
      [cardId, payload.agentId, setCardPayload]
    )
  );

  const handleRetryInject = useCallback(() => {
    if (retryBusy) return;
    const failure = payload.lastInjectFailure;
    if (!failure || !payload.teamId || !payload.agentId) return;
    setRetryBusy(true);
    void window.api.team
      .retryInject({
        teamId: payload.teamId,
        messageId: failure.messageId,
        agentId: payload.agentId
      })
      .then((result) => {
        if (result.ok) {
          // 成功時は warning row を消す。Hub からは team:handoff event が来るので
          // 配信成功は Canvas 側 ActivityFeed / HandoffEdge が拾う。
          setCardPayload(cardId, { lastInjectFailure: undefined });
          showToast(t('injectFailure.retrySuccess'), { tone: 'success', duration: 5000 });
        } else {
          // 再失敗。Hub が `team:inject_failed` を再 emit するので useTeamInjectFailed が
          // 新しい reason を payload に書き込む (= warning row はそのまま、内容だけ更新)。
          const reason = result.reasonCode ?? result.error ?? 'unknown';
          showToast(t('injectFailure.retryFailed', { reason }), {
            tone: 'error',
            duration: 8000
          });
        }
      })
      .catch((err) => {
        // unknown_team / unknown_message / invalid_recipient の構造化エラーはここに来る。
        // Issue #737: retryInject の reject は CommandError (Error サブクラス) に統一済み。
        // `err instanceof Error` 分岐が clean な message を取り出す (旧来の raw JSON 文字列
        // reject も invokeCommand wrapper が CommandError へ正規化するため契約は不変)。
        const detail = err instanceof Error ? err.message : String(err);
        showToast(t('injectFailure.retryError', { detail }), {
          tone: 'error',
          duration: 8000
        });
      })
      .finally(() => setRetryBusy(false));
  }, [retryBusy, payload.lastInjectFailure, payload.teamId, payload.agentId, cardId, setCardPayload, showToast, t]);

  const handleDismissInjectWarning = useCallback(() => {
    setCardPayload(cardId, { lastInjectFailure: undefined });
  }, [cardId, setCardPayload]);

  const failure = payload.lastInjectFailure;
  if (!failure) return null;

  // 通常時は何も rendering されず、`team:inject_failed` が来た瞬間に出現する。
  // `__summary` block の sibling として置き、既存 header の flex レイアウトを破壊しない。
  return (
    <div className="canvas-agent-card__inject-warning" role="alert" aria-live="polite">
      <AlertTriangle
        size={12}
        strokeWidth={2}
        className="canvas-agent-card__inject-warning__icon"
        aria-hidden="true"
      />
      <span
        className="canvas-agent-card__inject-warning__text"
        title={failure.reason.message}
      >
        {t('injectFailure.title', {
          code: failure.reason.code,
          message: failure.reason.message
        })}
      </span>
      <button
        type="button"
        className="nodrag canvas-agent-card__inject-warning__retry"
        onClick={handleRetryInject}
        disabled={retryBusy}
        title={t('injectFailure.retry')}
        aria-label={t('injectFailure.retry')}
      >
        <RotateCcw size={11} strokeWidth={2} aria-hidden="true" />
        <span>{retryBusy ? t('injectFailure.retryBusy') : t('injectFailure.retry')}</span>
      </button>
      <button
        type="button"
        className="nodrag canvas-agent-card__inject-warning__dismiss"
        onClick={handleDismissInjectWarning}
        title={t('injectFailure.dismiss')}
        aria-label={t('injectFailure.dismiss')}
      >
        ×
      </button>
    </div>
  );
}

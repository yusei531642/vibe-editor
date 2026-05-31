/**
 * AgentNodeCard / CardSummary
 *
 * Issue #735: 旧 `CardFrame.tsx` (~900 行 god card) から「カードの状態サマリ」
 * (current task / 経過時間 / Leader 入力待ち / health / 未読 inbox) のプレゼン
 * テーションだけを切り出した子コンポーネント。
 *
 * 純粋な表示コンポーネント: 値は親 (CardFrame) が `deriveCardSummary` /
 * `deriveHealth` で算出して props で渡す。本コンポーネントは store も IPC も触らない。
 * 挙動・DOM・クラス名は元 `.canvas-agent-card__summary` ブロックと完全一致。
 */
import type { JSX } from 'react';
import { AlertTriangle, Clock, ClipboardList, Heart, HeartPulse, Skull } from 'lucide-react';
import type { HealthState } from '../../../../lib/agent-health';
import type { CardSummary as CardSummaryData } from '../../../../lib/agent-summary';

/** i18n の `t` 関数シグネチャ (CardFrame から渡される)。 */
type TFn = (key: string, params?: Record<string, string | number>) => string;

/**
 * Issue #521: deriveCardSummary が返す `{ unit, value }` を i18n キーに変換する。
 * unit が 'now' の時は値を埋め込まないキー、それ以外は `{value}` パラメータを渡す。
 * lastOutputAgo が null (= 起動直後で未観測) のときは「観測なし」のキーへフォールバック。
 */
export function formatAgoLabel(
  ago: { unit: 'now' | 'sec' | 'min' | 'hour' | 'day'; value: number } | null,
  t: TFn
): string {
  if (ago === null) return t('agentCard.summary.ago.unobserved');
  if (ago.unit === 'now') return t('agentCard.summary.ago.now');
  return t(`agentCard.summary.ago.${ago.unit}`, { value: ago.value });
}

/**
 * Issue #510: 「●alive | ◐stale | ○dead」 + 経過秒/分 + 自己申告ステータスを 1 行に整形する。
 * - alive: status があれば status を出す。なければ 'alive' のみ。
 * - stale / dead: 経過時間を強調 ('沈黙 N 分')。
 */
export function formatHealthLabel(
  state: HealthState,
  ageMs: number | null,
  currentStatus: string | null,
  t: TFn
): string {
  const stateLabel = t(`agentCard.summary.health.state.${state}`);
  if (state === 'alive') {
    if (currentStatus && currentStatus.trim().length > 0) {
      const status = currentStatus.length > 32 ? currentStatus.slice(0, 31) + '…' : currentStatus;
      return `${stateLabel} · ${status}`;
    }
    return stateLabel;
  }
  if (ageMs === null) return stateLabel;
  // 沈黙時間: 1 分未満は秒、それ以上は分単位 (停滞は「N 分」が直感的)。
  const sec = Math.floor(ageMs / 1000);
  if (sec < 60) {
    return t('agentCard.summary.health.silent.sec', { state: stateLabel, value: sec });
  }
  const min = Math.floor(sec / 60);
  return t('agentCard.summary.health.silent.min', { state: stateLabel, value: min });
}

/** CardSummary 内の health 行が必要とする health 由来の値。 */
export interface CardSummaryHealth {
  state: HealthState;
  ageMs: number | null;
  currentStatus: string | null;
  /** 未読 inbox 行の stalled 判定 (TeamHub diagnostics 由来)。 */
  stalledInbound: boolean;
  /** TeamHub diagnostics が観測した「一番古い未読の経過 ms」。 */
  oldestPendingInboxAgeMs: number | null;
}

interface CardSummaryProps {
  /** deriveCardSummary の結果 (task / 経過 / needsLeaderInput)。 */
  summary: CardSummaryData;
  /** deriveHealth の結果から CardSummary が使う部分。 */
  health: CardSummaryHealth;
  /** health 行を出すか (teamId / agentId が両方揃い、state !== 'unknown' のとき)。 */
  showHealthRow: boolean;
  /** TeamHub diagnostics 行が存在するか。未読経過 ms の算出経路を切り替える。 */
  hasHealthRow: boolean;
  /** 配信済み未読 message 数。0 のとき未読行は描画しない。 */
  unreadInboxCount: number;
  /** payload 由来の「一番古い未読の delivered 時刻」(RFC3339)。fallback 経路で使う。 */
  oldestUnreadDeliveredAt: string | undefined;
  /** 経過時間表示用の現在時刻 (15s 間隔で更新される nowTick)。 */
  nowTick: number;
  t: TFn;
}

/** Issue #735: 旧 CardFrame の `.canvas-agent-card__summary` ブロック。 */
export function CardSummary({
  summary,
  health,
  showHealthRow,
  hasHealthRow,
  unreadInboxCount,
  oldestUnreadDeliveredAt,
  nowTick,
  t
}: CardSummaryProps): JSX.Element {
  const summaryAgoLabel = formatAgoLabel(summary.lastOutputAgo, t);
  return (
    <div
      className={
        'canvas-agent-card__summary' +
        (summary.needsLeaderInput ? ' canvas-agent-card__summary--alert' : '')
      }
      aria-label={t('agentCard.summary.region')}
    >
      <div
        className="canvas-agent-card__summary-row canvas-agent-card__summary-row--task"
        title={summary.taskTitle || t('agentCard.summary.noTask')}
      >
        <ClipboardList size={11} strokeWidth={2} aria-hidden="true" />
        <span className="canvas-agent-card__summary-text">
          {summary.taskTitle || t('agentCard.summary.noTask')}
        </span>
      </div>
      <div className="canvas-agent-card__summary-row canvas-agent-card__summary-row--clock">
        <Clock size={11} strokeWidth={2} aria-hidden="true" />
        <span className="canvas-agent-card__summary-text">{summaryAgoLabel}</span>
      </div>
      {summary.needsLeaderInput ? (
        <div
          className="canvas-agent-card__summary-row canvas-agent-card__summary-row--leader"
          role="status"
        >
          <AlertTriangle size={11} strokeWidth={2} aria-hidden="true" />
          <span className="canvas-agent-card__summary-text">
            {t('agentCard.summary.needsLeader')}
          </span>
        </div>
      ) : null}
      {/* Issue #510: 自カードに対応する TeamHub diagnostics 行から health badge を表示する。 */}
      {/* teamId / agentId が無いスタンドアロンカードでは何も出さない (= state==='unknown' は描画しない)。 */}
      {showHealthRow ? (
        <div
          className={
            'canvas-agent-card__summary-row canvas-agent-card__summary-row--health' +
            ' canvas-agent-card__summary-row--health-' +
            health.state
          }
          role="status"
          title={t('agentCard.summary.health.tooltip', {
            state: t(`agentCard.summary.health.state.${health.state}`),
            status: health.currentStatus ?? t('agentCard.summary.health.noStatus')
          })}
        >
          {health.state === 'alive' ? (
            <Heart size={11} strokeWidth={2.2} aria-hidden="true" />
          ) : health.state === 'stale' ? (
            <HeartPulse size={11} strokeWidth={2.2} aria-hidden="true" />
          ) : (
            <Skull size={11} strokeWidth={2.2} aria-hidden="true" />
          )}
          <span className="canvas-agent-card__summary-text">
            {formatHealthLabel(health.state, health.ageMs, health.currentStatus, t)}
          </span>
        </div>
      ) : null}
      {/*
       * Issue #808: 配送済み未読 inbox の数を出していた行 (Issue #509) を撤去。
       * 背後の `unreadInboxCount` / `oldestUnreadDeliveredAt` 追跡 (Issue #596 で
       * race fix 済み) は store 側に残す: `stalledInbound` の警告色は health 行が
       * 引き続き表示するため、tracking 自体は alive な観測情報として有効。
       */}
    </div>
  );
}

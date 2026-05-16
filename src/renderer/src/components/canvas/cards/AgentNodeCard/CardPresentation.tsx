/**
 * AgentNodeCard / CardPresentation
 *
 * Issue #735: 旧 `CardFrame.tsx` (~900 行 god card) から「カードヘッダーの視覚表現」
 * (avatar / title / organization / role badge / status pill / close ボタン) を
 * 切り出した子コンポーネント。
 *
 * 純粋な表示コンポーネント: 値は親 (CardFrame) が解決して props で渡す。
 * handoff ボタンは責務分離のため `handoff` slot (ReactNode) で受け取り、本体は
 * その配置だけを担う (handoff ロジックは CardHandoff.tsx)。
 * 挙動・DOM・クラス名は元 `.canvas-agent-card__header` と完全一致。
 */
import type { ReactNode } from 'react';
import type { AgentStatus } from './types';

/** i18n の `t` 関数シグネチャ。 */
type TFn = (key: string, params?: Record<string, string | number>) => string;

/**
 * pty 起動時の status 文字列 ("実行中: claude --append-system-prompt ...long text...") を
 * 最初のフラグ/引数まで切り詰める。チームプロンプトなど巨大な文字列がヘッダに溢れるのを防ぐ。
 */
export function shortStatus(s: string): string {
  // "実行中: claude --append-system-prompt あなたは..." → "実行中: claude"
  const m = s.match(/^(\S+:\s*)?([^\s]+)/);
  if (m) return `${m[1] ?? ''}${m[2]}`;
  return s.length > 32 ? s.slice(0, 32) + '…' : s;
}

/** ヘッダー右の小さなステータスドット (idle=灰, thinking=黄, typing=accent パルス) */
function StatusBadge({ state, label }: { state: AgentStatus; label: string }): JSX.Element {
  return (
    <span
      title={label}
      aria-label={label}
      className={`canvas-agent-status canvas-agent-status--${state}`}
    >
      <span className="canvas-agent-status__dot" />
      <span>{label}</span>
    </span>
  );
}

interface CardPresentationProps {
  /** Canvas ノード id (close ボタンの対象)。 */
  cardId: string;
  /** カードタイトル。 */
  title: string;
  /** ロール表示ラベル (リーダー / プログラマー 等)。 */
  roleLabel: string;
  /** ロール由来の avatar glyph。 */
  glyph: string;
  /** 所属組織名 (複数組織運用時のみ。無ければ非表示)。 */
  organizationName: string | undefined;
  /** 現在のアクティビティ状態 (idle / thinking / typing)。 */
  activity: AgentStatus;
  /** pty 起動 status 文字列 (空なら status pill 非表示)。 */
  status: string;
  /** handoff ボタン slot (Leader 以外では呼び出し側が null を渡す)。 */
  handoff: ReactNode;
  /** close ボタン押下時 (チーム cascade confirm 込み)。 */
  onClose: () => void;
  t: TFn;
}

/** Issue #735: 旧 CardFrame の `.canvas-agent-card__header`。 */
export function CardPresentation({
  title,
  roleLabel,
  glyph,
  organizationName,
  activity,
  status,
  handoff,
  onClose,
  t
}: CardPresentationProps): JSX.Element {
  return (
    <header className="canvas-agent-card__header">
      <span className="canvas-agent-card__title-row">
        <span aria-hidden="true" className="canvas-agent-card__avatar">
          {glyph}
        </span>
        <span className="canvas-agent-card__title">{title}</span>
        {organizationName && (
          <span className="canvas-agent-card__organization">{organizationName}</span>
        )}
        <span className="canvas-agent-card__role">{roleLabel}</span>
      </span>
      <span className="canvas-agent-card__actions">
        <StatusBadge state={activity} label={t(`agentStatus.${activity}`)} />
        {status && (
          <span className="canvas-agent-card__status" title={status}>
            {shortStatus(status)}
          </span>
        )}
        {handoff}
        <button
          type="button"
          className="nodrag canvas-agent-card__close"
          onClick={onClose}
          title={t('agentCard.close')}
          aria-label={t('agentCard.close')}
        >
          ×
        </button>
      </span>
    </header>
  );
}

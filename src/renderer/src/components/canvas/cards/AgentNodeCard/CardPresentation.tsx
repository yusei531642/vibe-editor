/**
 * AgentNodeCard / CardPresentation
 *
 * Issue #735: 旧 `CardFrame.tsx` god card から「カードヘッダーの視覚表現」を切り出した子。
 * Issue #1115 (Phase2): role glyph アバターを **エージェント種別アイコン** (agent-registry の
 * 記述子由来, lucide) に置き換え、ロールは muted な inline ラベルに降格。状態は色+形のドット+語
 * で表す。種別 (claude/codex/custom) が一目で区別できる Option A (1 行・アイコン先頭) レイアウト。
 *
 * 純粋な表示コンポーネント: 値は親 (CardFrame) が解決して props で渡す。handoff は slot で受ける。
 */
import type { ReactNode } from 'react';
import type { AgentStatus } from './types';
import { AgentTypeIcon } from './AgentTypeIcon';

/** i18n の `t` 関数シグネチャ。 */
type TFn = (key: string, params?: Record<string, string | number>) => string;

/**
 * ヘッダー右の状態バッジ (idle=灰 / thinking=マスタード / typing=accent パルス)。
 * 色だけでなくドットの形・パルスでも状態を識別できる (claude-design: form over color)。
 * pty 起動 status 文字列は tooltip に退避する。
 */
function StatusBadge({
  state,
  label,
  title
}: {
  state: AgentStatus;
  label: string;
  title?: string;
}): JSX.Element {
  return (
    <span
      title={title || label}
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
  /** Issue #1115: エージェント種別アイコン (lucide 名, agent-registry 記述子由来)。 */
  typeIcon: string;
  /** 種別の表示名 (アイコンの tooltip 用)。 */
  typeName: string;
  /** 種別の accent カラー (custom のみ。未指定はロール accent を継承)。 */
  typeAccent?: string;
  /** 所属組織名 (複数組織運用時のみ。無ければ非表示)。 */
  organizationName: string | undefined;
  /** 現在のアクティビティ状態 (idle / thinking / typing)。 */
  activity: AgentStatus;
  /** pty 起動 status 文字列 (状態バッジの tooltip に表示)。 */
  status: string;
  /** handoff ボタン slot (Leader 以外では呼び出し側が null を渡す)。 */
  handoff: ReactNode;
  /** close ボタン押下時 (チーム cascade confirm 込み)。 */
  onClose: () => void;
  t: TFn;
}

/** Issue #735 / #1115: `.canvas-agent-card__header` (Option A: アイコン先頭・1 行・高密度)。 */
export function CardPresentation({
  title,
  roleLabel,
  typeIcon,
  typeName,
  typeAccent,
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
        <span
          className="canvas-agent-card__type-icon"
          style={typeAccent ? { color: typeAccent } : undefined}
          title={typeName}
          aria-label={typeName}
        >
          <AgentTypeIcon name={typeIcon} />
        </span>
        <span className="canvas-agent-card__title">{title}</span>
        {organizationName && (
          <span className="canvas-agent-card__organization">{organizationName}</span>
        )}
        <span className="canvas-agent-card__role canvas-agent-card__role--inline">
          ·{roleLabel}
        </span>
      </span>
      <span className="canvas-agent-card__actions">
        <StatusBadge state={activity} label={t(`agentStatus.${activity}`)} title={status} />
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

import { useMemo, useState } from 'react';
import type { TeamRole } from '../../../../types/shared';
import { useT } from '../../lib/i18n';
import {
  type ActivityEvent,
  groupEventsByRecency
} from '../../lib/use-activity-feed';

type FilterKind = 'all' | 'handoff' | 'status' | 'error';

interface ActivityPanelProps {
  events: ActivityEvent[];
  /** drawer モード時に activity--drawer を追加する等の拡張用 */
  className?: string;
  style?: React.CSSProperties;
  onClose?: () => void;
}

/**
 * Claude Design バンドルの .activity (300px 右パネル) を移植。
 * 時刻グループ + 役割色ドットのタイムライン + フィルタチップ。
 * useActivityFeed フックから events を渡して描画のみを担当。
 */
export function ActivityPanel({
  events,
  className,
  style,
  onClose
}: ActivityPanelProps): JSX.Element {
  const t = useT();
  const [filter, setFilter] = useState<FilterKind>('all');

  const filtered = useMemo(() => {
    if (filter === 'all') return events;
    return events.filter((e) => (e.kind as FilterKind) === filter);
  }, [events, filter]);

  const groups = useMemo(() => groupEventsByRecency(filtered), [filtered]);

  const filterChips: Array<{ id: FilterKind; label: string }> = [
    { id: 'all', label: t('activity.filter.all') },
    { id: 'handoff', label: t('activity.filter.handoff') },
    { id: 'status', label: t('activity.filter.tool') },
    { id: 'error', label: t('activity.filter.error') }
  ];

  return (
    <aside className={`activity${className ? ' ' + className : ''}`} style={style} aria-label="Activity feed">
      <div className="activity__header">
        <div className="activity__header-row">
          <h2 className="activity__title">{t('activity.title')}</h2>
          {onClose ? (
            <button
              type="button"
              className="activity__close"
              onClick={onClose}
              aria-label={t('common.close')}
            >
              ×
            </button>
          ) : null}
        </div>
        <div className="activity__sub">
          <span className="activity__live-dot" aria-hidden="true" />
          <span>{t('activity.live')}</span>
          <span style={{ opacity: 0.5 }}>·</span>
          <span>{events.length}</span>
        </div>
      </div>

      <div className="activity__filters">
        {filterChips.map((c) => (
          <button
            type="button"
            key={c.id}
            className={`activity__filter${filter === c.id ? ' is-active' : ''}`}
            onClick={() => setFilter(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="activity__body">
        {filtered.length === 0 ? (
          <div className="activity__empty">{t('activity.empty')}</div>
        ) : (
          groups.map((group) => (
            <div key={group.key} className="feed-group">
              <div className="feed-group__label">{groupLabel(group.key, t)}</div>
              {group.items.map((ev) => (
                <FeedItem key={ev.id} event={ev} />
              ))}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}

function FeedItem({ event }: { event: ActivityEvent }): JSX.Element {
  const color = roleColorVar(event.fromRole ?? event.role ?? null);
  const dateLabel = new Date(event.ts).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  return (
    <div className="feed-item" style={{ ['--role-color' as string]: color }}>
      <span className="feed-item__dot" aria-hidden="true" />
      <div className="feed-item__time">{dateLabel}</div>
      <div className="feed-item__head">
        {event.fromRole ? (
          <span className="feed-item__role">{event.fromRole}</span>
        ) : null}
        {event.toRole ? (
          <>
            <span className="feed-item__arrow">→</span>
            <span className="feed-item__target">{event.toRole}</span>
          </>
        ) : null}
        {!event.fromRole && !event.toRole ? (
          <span className="feed-item__target">{event.title}</span>
        ) : null}
      </div>
      {event.body ? (
        <div className={`feed-item__body${event.kind === 'handoff' ? '' : ' is-task'}`}>
          {event.body}
        </div>
      ) : null}
    </div>
  );
}

function roleColorVar(role: TeamRole | string | null | undefined): string {
  if (!role) return 'var(--accent)';
  // v3: 固定ワーカーロール撤廃。leader 以外は動的ロールなので accent にフォールバック。
  // RoleProfilesContext を使えば正確な色が取れるが、ActivityPanel は静的色だけで十分。
  if ((role as string) === 'leader') return 'var(--role-leader)';
  return 'var(--accent)';
}

function groupLabel(
  key: 'now' | 'minute' | 'hour' | 'earlier',
  t: (k: string, p?: Record<string, string | number>) => string
): string {
  switch (key) {
    case 'now':
      return t('activity.groupNow');
    case 'minute':
      return t('activity.groupMinute');
    case 'hour':
      return t('activity.groupHour');
    case 'earlier':
    default:
      return t('activity.groupEarlier');
  }
}

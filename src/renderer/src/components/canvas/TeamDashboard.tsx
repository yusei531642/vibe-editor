/**
 * TeamDashboard — Issue #514.
 *
 * Canvas 上のチーム (= 同 teamId の agent カード群) を一覧化する集約 UI。
 * 4 名以上のチームでも Leader が状態を破綻させず把握できることをゴールとする。
 *
 * 設計:
 *   - 親 (StageHud) が popover として表示する。teamId は active leader 経由で受け取る。
 *   - 行データは `useTeamDashboard` hook が canvas + agent-activity + team_state_read を
 *     合成して返す。本コンポーネントは表示のみに集中する。
 *   - 状態色: active=success, blocked=warning, stale=info-mute, completed=accent。
 *   - 0 件 / teamId 未確定時は空状態メッセージを出す。
 */
import { useMemo } from 'react';
import { AlertTriangle, CheckCircle2, CircleDot, Hourglass, MoonStar } from 'lucide-react';
import { useT } from '../../lib/i18n';
import { useTeamDashboard, type TeamDashboardRow } from '../../lib/use-team-dashboard';

interface TeamDashboardProps {
  teamId: string | null;
  projectRoot: string | null;
  onClose: () => void;
}

function formatRelative(now: number, ts: number | null): string | null {
  if (ts === null) return null;
  const diff = Math.max(0, now - ts);
  if (diff < 5_000) return 'now';
  if (diff < 60_000) return `${Math.floor(diff / 1_000)}s`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

function StateBadge({ state }: { state: TeamDashboardRow['state'] }): JSX.Element {
  const t = useT();
  const cls = `tc__dash-state tc__dash-state--${state}`;
  switch (state) {
    case 'active':
      return (
        <span className={cls}>
          <CircleDot size={11} strokeWidth={2.2} aria-hidden="true" />
          <span>{t('dashboard.state.active')}</span>
        </span>
      );
    case 'blocked':
      return (
        <span className={cls}>
          <AlertTriangle size={11} strokeWidth={2.2} aria-hidden="true" />
          <span>{t('dashboard.state.blocked')}</span>
        </span>
      );
    case 'stale':
      return (
        <span className={cls}>
          <Hourglass size={11} strokeWidth={2.2} aria-hidden="true" />
          <span>{t('dashboard.state.stale')}</span>
        </span>
      );
    case 'completed':
      return (
        <span className={cls}>
          <CheckCircle2 size={11} strokeWidth={2.2} aria-hidden="true" />
          <span>{t('dashboard.state.completed')}</span>
        </span>
      );
    default:
      return (
        <span className={cls}>
          <MoonStar size={11} strokeWidth={2.2} aria-hidden="true" />
          <span>{t('dashboard.state.idle')}</span>
        </span>
      );
  }
}

export function TeamDashboard({ teamId, projectRoot, onClose }: TeamDashboardProps): JSX.Element {
  const t = useT();
  const { rows, aggregate, state, empty } = useTeamDashboard({ teamId, projectRoot });
  // 表示用の "now" は描画タイミングで固定。15 秒間隔の親 StageHud 再 render に乗る想定で
  // ここではフレーム単位の固定値とし、相対時間がチラつかないようにする。
  const now = useMemo(() => Date.now(), [rows.length, aggregate.hasAttention, state?.updatedAt]);

  return (
    <div
      className="tc__dashboard glass-surface"
      role="dialog"
      aria-label={t('dashboard.title')}
    >
      <div className="tc__dashboard-header">
        <span className="tc__dashboard-title">{t('dashboard.title')}</span>
        <span className="tc__dashboard-count">
          {t('dashboard.count', { count: aggregate.total })}
        </span>
        <button
          type="button"
          className="tc__dashboard-close"
          onClick={onClose}
          aria-label={t('common.close')}
          title={t('common.close')}
        >
          ×
        </button>
      </div>

      {state?.humanGate?.blocked ? (
        <div className="tc__dashboard-banner" role="status">
          <AlertTriangle size={12} strokeWidth={2} aria-hidden="true" />
          <span>{state.humanGate.reason ?? t('dashboard.banner.humanGate')}</span>
        </div>
      ) : null}

      {empty ? (
        <div className="tc__dashboard-empty">
          {teamId
            ? t('dashboard.empty.noMembers')
            : t('dashboard.empty.noTeam')}
        </div>
      ) : (
        <table className="tc__dashboard-table">
          <thead>
            <tr>
              <th scope="col">{t('dashboard.col.member')}</th>
              <th scope="col">{t('dashboard.col.state')}</th>
              <th scope="col">{t('dashboard.col.task')}</th>
              <th scope="col">{t('dashboard.col.lastSeen')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.cardId}
                className={
                  'tc__dashboard-row tc__dashboard-row--' + row.state
                }
              >
                <td>
                  <div className="tc__dashboard-member">
                    <span className="tc__dashboard-member-title">{row.title}</span>
                    <span className="tc__dashboard-member-meta">
                      {row.roleProfileId} · {row.agent}
                    </span>
                  </div>
                </td>
                <td>
                  <StateBadge state={row.state} />
                  {row.alert ? (
                    <div className="tc__dashboard-alert" title={row.alert}>
                      {row.alert}
                    </div>
                  ) : null}
                </td>
                <td className="tc__dashboard-task">
                  {row.task ? (
                    <>
                      <div
                        className="tc__dashboard-task-title"
                        title={row.task.summary ?? row.task.description}
                      >
                        {row.task.summary ?? row.task.description}
                      </div>
                      <div className="tc__dashboard-task-meta">
                        #{row.task.id} · {row.task.status}
                      </div>
                    </>
                  ) : (
                    <span className="tc__dashboard-task-empty">
                      {t('dashboard.task.unassigned')}
                    </span>
                  )}
                </td>
                <td className="tc__dashboard-cell-num">
                  {formatRelative(now, row.lastActivityAt) ??
                    t('dashboard.lastSeen.never')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="tc__dashboard-footer">
        <span className="tc__dashboard-foot-pill tc__dashboard-foot-pill--active">
          {t('dashboard.state.active')}: {aggregate.active}
        </span>
        <span
          className={
            'tc__dashboard-foot-pill tc__dashboard-foot-pill--blocked' +
            (aggregate.blocked > 0 ? ' is-on' : '')
          }
        >
          {t('dashboard.state.blocked')}: {aggregate.blocked}
        </span>
        <span
          className={
            'tc__dashboard-foot-pill tc__dashboard-foot-pill--stale' +
            (aggregate.stale > 0 ? ' is-on' : '')
          }
        >
          {t('dashboard.state.stale')}: {aggregate.stale}
        </span>
        <span className="tc__dashboard-foot-pill tc__dashboard-foot-pill--completed">
          {t('dashboard.state.completed')}: {aggregate.completed}
        </span>
        <span className="tc__dashboard-foot-pill tc__dashboard-foot-pill--idle">
          {t('dashboard.state.idle')}: {aggregate.idle}
        </span>
      </div>
    </div>
  );
}

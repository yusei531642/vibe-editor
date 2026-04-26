import { useMemo, useState } from 'react';
import { RefreshCw, Users, X } from 'lucide-react';
import type { SessionInfo, TeamHistoryEntry } from '../../../types/shared';
import { useT } from '../lib/i18n';
import { useSettings } from '../lib/settings-context';

interface SessionsPanelProps {
  sessions: SessionInfo[];
  loading: boolean;
  activeSessionId: string | null;
  onRefresh: () => void;
  onResume: (session: SessionInfo) => void;

  /** チーム履歴。空なら Teams セクション自体を出さない */
  teamHistory: TeamHistoryEntry[];
  onResumeTeam: (entry: TeamHistoryEntry) => void;
  onDeleteTeamHistory: (id: string) => void;
}

/** 相対時刻表示（例: "3分前", "2 hours ago", "yesterday"）。
 *  Issue #130: 旧 API は毎呼び出し iso → Date.parse → getTime を 2 回実行していた。
 *  parsed timestamp (ms) を受け取る形に変更し、呼び出し側で 1 回だけ parse する。 */
function relativeTime(
  thenMs: number,
  rtf: Intl.RelativeTimeFormat,
  dateFormatter: Intl.DateTimeFormat
): string {
  if (!Number.isFinite(thenMs)) return '';
  const diffSec = Math.round((thenMs - Date.now()) / 1000);
  const absSec = Math.abs(diffSec);
  if (absSec < 60) return rtf.format(diffSec, 'second');
  const diffMin = Math.round(diffSec / 60);
  if (Math.abs(diffMin) < 60) return rtf.format(diffMin, 'minute');
  const diffHour = Math.round(diffMin / 60);
  if (Math.abs(diffHour) < 24) return rtf.format(diffHour, 'hour');
  const diffDay = Math.round(diffHour / 24);
  if (Math.abs(diffDay) < 7) return rtf.format(diffDay, 'day');
  return dateFormatter.format(new Date(thenMs));
}

/** 初期表示件数。これを超えるセッションは "Load more" でページング表示する */
const INITIAL_VISIBLE = 50;
const PAGE_SIZE = 50;

export function SessionsPanel({
  sessions,
  loading,
  activeSessionId,
  onRefresh,
  onResume,
  teamHistory,
  onResumeTeam,
  onDeleteTeamHistory
}: SessionsPanelProps): JSX.Element {
  const t = useT();
  const { settings } = useSettings();
  const locale = settings.language === 'ja' ? 'ja-JP' : 'en-US';
  const rtf = useMemo(
    () => new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }),
    [locale]
  );
  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }),
    [locale]
  );
  // Issue #130: lastModifiedAt の Date.parse を毎レンダーから 1 回だけに削減。
  // さらに Rust 側で事前計算した lastModifiedMs を優先して、fetch のたびの再 parse も避ける。
  const sessionTimes = useMemo(
    () => sessions.map((s) => s.lastModifiedMs ?? (Date.parse(s.lastModifiedAt) || 0)),
    [sessions]
  );
  const teamTimes = useMemo(
    () => teamHistory.map((e) => Date.parse(e.lastUsedAt) || 0),
    [teamHistory]
  );
  // Issue #130: 200+ 件あるセッションを全描画するとサイドバー切替に 200ms+ かかる。
  // ページング表示で初期は 50 件、ボタンで +50 件ずつ増やす。
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);
  const visibleSessions = useMemo(
    () => sessions.slice(0, visibleCount),
    [sessions, visibleCount]
  );
  const hasMore = sessions.length > visibleCount;
  return (
    <div className="sidebar-view">
      <header className="sidebar-view__header">
        <div className="sidebar-view__meta">
          <span className="git-count">
            {t('sidebar.sessionCount', { count: sessions.length })}
          </span>
        </div>
        <button
          type="button"
          className="sidebar__section-btn"
          onClick={onRefresh}
          title={t('sidebar.refresh')}
          aria-label={t('sidebar.refresh')}
        >
          <RefreshCw size={13} strokeWidth={2} />
        </button>
      </header>

      {/* Teams セクション: チーム履歴 */}
      {teamHistory.length > 0 && (
        <>
          <div className="sidebar-section-label">
            <Users size={11} strokeWidth={2} />
            <span>{t('sidebar.teams')}</span>
            <span className="sidebar-section-label__count">{teamHistory.length}</span>
          </div>
          <ul className="team-history-list">
            {teamHistory.map((entry, i) => {
              const memberSummary = entry.members
                .map((m) => m.role)
                .slice(0, 5)
                .join(' · ');
              return (
                <li key={entry.id} className="team-history-item">
                  <button
                    type="button"
                    className="team-history-item__main"
                    onClick={() => onResumeTeam(entry)}
                    title={t('teamHistory.resume', { name: entry.name })}
                  >
                    <div className="team-history-item__top">
                      <span className="team-history-item__name">{entry.name}</span>
                      <span className="team-history-item__time">
                        {relativeTime(teamTimes[i] ?? 0, rtf, dateFormatter)}
                      </span>
                    </div>
                    <div className="team-history-item__roles">
                      {memberSummary}
                      {entry.members.length > 5 ? ` +${entry.members.length - 5}` : ''}
                    </div>
                  </button>
                  <button
                    type="button"
                    className="team-history-item__delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteTeamHistory(entry.id);
                    }}
                    title={t('teamHistory.delete')}
                    aria-label={t('teamHistory.delete')}
                  >
                    <X size={11} strokeWidth={2} />
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {/* Single セッションセクション: 既存の Claude Code セッション履歴 */}
      {teamHistory.length > 0 && (
        <div className="sidebar-section-label">
          <span>{t('sidebar.singleSessions')}</span>
          <span className="sidebar-section-label__count">{sessions.length}</span>
        </div>
      )}

      {loading && (
        <div className="skeleton-list" aria-label={t('sidebar.loading')} aria-busy="true">
          <div className="skeleton skeleton--session" />
          <div className="skeleton skeleton--session" />
          <div className="skeleton skeleton--session" />
          <div className="skeleton skeleton--session" />
        </div>
      )}

      {!loading && sessions.length === 0 && (
        <p className="sidebar__note sidebar__note--dim">{t('sidebar.noSessions')}</p>
      )}

      <ul className="sessions">
        {visibleSessions.map((s, i) => {
          const isActive = activeSessionId === s.id;
          return (
            <li key={s.id}>
              <button
                type="button"
                className={`session ${isActive ? 'is-active' : ''}`}
                onClick={() => onResume(s)}
                title={t('sessions.resume', { id: s.id.slice(0, 8) })}
              >
                <div className="session__top">
                  <span className="session__time">
                    {relativeTime(sessionTimes[i] ?? 0, rtf, dateFormatter)}
                  </span>
                  <span className="session__count">
                    {t('sessions.messages', { count: s.messageCount })}
                  </span>
                </div>
                <div className="session__title">{s.title}</div>
                <div className="session__id">{s.id.slice(0, 8)}</div>
              </button>
            </li>
          );
        })}
      </ul>
      {hasMore && (
        <button
          type="button"
          className="sidebar__section-btn"
          style={{ width: '100%', marginTop: 6 }}
          onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}
        >
          {t('sessions.loadMore', {
            remaining: sessions.length - visibleCount
          })}
        </button>
      )}
    </div>
  );
}

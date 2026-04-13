import { RefreshCw, Users, X } from 'lucide-react';
import type { SessionInfo, TeamHistoryEntry } from '../../../types/shared';
import { useT } from '../lib/i18n';

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

/** 相対時刻表示（例: "3分前", "2時間前", "昨日", "2026/03/01"） */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const now = Date.now();
  const diffSec = Math.round((now - then) / 1000);
  if (diffSec < 60) return `${diffSec}秒前`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}分前`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH}時間前`;
  const diffD = Math.round(diffH / 24);
  if (diffD < 7) return `${diffD}日前`;
  const d = new Date(iso);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

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
            {teamHistory.map((entry) => {
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
                        {relativeTime(entry.lastUsedAt)}
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
        {sessions.map((s) => {
          const isActive = activeSessionId === s.id;
          return (
            <li key={s.id}>
              <button
                type="button"
                className={`session ${isActive ? 'is-active' : ''}`}
                onClick={() => onResume(s)}
                title={`セッション ${s.id} に戻る`}
              >
                <div className="session__top">
                  <span className="session__time">{relativeTime(s.lastModifiedAt)}</span>
                  <span className="session__count">{s.messageCount} msgs</span>
                </div>
                <div className="session__title">{s.title}</div>
                <div className="session__id">{s.id.slice(0, 8)}</div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

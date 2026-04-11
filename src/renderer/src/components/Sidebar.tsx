import type {
  GitFileChange,
  GitStatus,
  SessionInfo
} from '../../../types/shared';
import { ChangesPanel } from './ChangesPanel';
import { SessionsPanel } from './SessionsPanel';

export type SidebarView = 'changes' | 'sessions';

interface SidebarProps {
  view: SidebarView;
  onViewChange: (view: SidebarView) => void;

  // changes view
  gitStatus: GitStatus | null;
  gitLoading: boolean;
  onRefreshGit: () => void;
  onOpenDiff: (file: GitFileChange) => void;
  activeDiffPath: string | null;

  // sessions view
  sessions: SessionInfo[];
  sessionsLoading: boolean;
  activeSessionId: string | null;
  onRefreshSessions: () => void;
  onResumeSession: (session: SessionInfo) => void;
}

export function Sidebar(props: SidebarProps): JSX.Element {
  return (
    <aside className="sidebar">
      <nav className="sidebar-switcher" role="tablist" aria-label="サイドバービュー">
        <button
          type="button"
          role="tab"
          aria-selected={props.view === 'changes'}
          className={`sidebar-switcher__btn ${props.view === 'changes' ? 'is-active' : ''}`}
          onClick={() => props.onViewChange('changes')}
        >
          変更
          {props.gitStatus?.ok && props.gitStatus.files.length > 0 && (
            <span className="sidebar-switcher__badge">
              {props.gitStatus.files.length}
            </span>
          )}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={props.view === 'sessions'}
          className={`sidebar-switcher__btn ${props.view === 'sessions' ? 'is-active' : ''}`}
          onClick={() => props.onViewChange('sessions')}
        >
          履歴
          {props.sessions.length > 0 && (
            <span className="sidebar-switcher__badge">{props.sessions.length}</span>
          )}
        </button>
      </nav>

      <div className="sidebar__body">
        {props.view === 'changes' ? (
          <ChangesPanel
            status={props.gitStatus}
            loading={props.gitLoading}
            onRefresh={props.onRefreshGit}
            onOpenDiff={props.onOpenDiff}
            activeDiffPath={props.activeDiffPath}
          />
        ) : (
          <SessionsPanel
            sessions={props.sessions}
            loading={props.sessionsLoading}
            activeSessionId={props.activeSessionId}
            onRefresh={props.onRefreshSessions}
            onResume={props.onResumeSession}
          />
        )}
      </div>
    </aside>
  );
}

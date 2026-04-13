import type {
  GitFileChange,
  GitStatus,
  SessionInfo
} from '../../../types/shared';
import { ChangesPanel } from './ChangesPanel';
import { SessionsPanel } from './SessionsPanel';
import { FileTreePanel } from './FileTreePanel';
import { useT } from '../lib/i18n';

export type SidebarView = 'files' | 'changes' | 'sessions';

interface SidebarProps {
  view: SidebarView;
  onViewChange: (view: SidebarView) => void;

  // files view
  projectRoot: string;
  activeFilePath: string | null;
  onOpenFile: (relPath: string) => void;

  // changes view
  gitStatus: GitStatus | null;
  gitLoading: boolean;
  onRefreshGit: () => void;
  onOpenDiff: (file: GitFileChange) => void;
  onFileContextMenu: (e: React.MouseEvent, file: GitFileChange) => void;
  activeDiffPath: string | null;

  // sessions view
  sessions: SessionInfo[];
  sessionsLoading: boolean;
  activeSessionId: string | null;
  onRefreshSessions: () => void;
  onResumeSession: (session: SessionInfo) => void;
}

export function Sidebar(props: SidebarProps): JSX.Element {
  const t = useT();
  return (
    <aside className="sidebar">
      <div className="sidebar__header">
        <span className="sidebar__brand">vibe-editor</span>
      </div>
      <nav className="sidebar-switcher" role="tablist" aria-label="Sidebar view">
        <button
          type="button"
          role="tab"
          aria-selected={props.view === 'files'}
          className={`sidebar-switcher__btn ${props.view === 'files' ? 'is-active' : ''}`}
          onClick={() => props.onViewChange('files')}
        >
          {t('sidebar.files')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={props.view === 'changes'}
          className={`sidebar-switcher__btn ${props.view === 'changes' ? 'is-active' : ''}`}
          onClick={() => props.onViewChange('changes')}
        >
          {t('sidebar.changes')}
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
          {t('sidebar.history')}
          {props.sessions.length > 0 && (
            <span className="sidebar-switcher__badge">{props.sessions.length}</span>
          )}
        </button>
      </nav>

      <div className="sidebar__body" key={props.view}>
        {props.view === 'files' ? (
          <FileTreePanel
            projectRoot={props.projectRoot}
            activeFilePath={props.activeFilePath}
            onOpenFile={props.onOpenFile}
          />
        ) : props.view === 'changes' ? (
          <ChangesPanel
            status={props.gitStatus}
            loading={props.gitLoading}
            onRefresh={props.onRefreshGit}
            onOpenDiff={props.onOpenDiff}
            onFileContextMenu={props.onFileContextMenu}
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

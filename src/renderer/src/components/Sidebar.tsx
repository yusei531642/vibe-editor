import { Files, GitBranch, History } from 'lucide-react';
import type {
  GitFileChange,
  GitStatus,
  SessionInfo,
  TeamHistoryEntry
} from '../../../types/shared';
import { ChangesPanel } from './ChangesPanel';
import { SessionsPanel } from './SessionsPanel';
import { FileTreePanel } from './FileTreePanel';
import { AppMenu } from './AppMenu';
import { UserMenu } from './UserMenu';
import { useT } from '../lib/i18n';

export type SidebarView = 'files' | 'changes' | 'sessions';

interface SidebarProps {
  view: SidebarView;
  onViewChange: (view: SidebarView) => void;
  projectRoot: string;
  workspaceFolders: string[];
  onRemoveWorkspaceFolder: (path: string) => void;
  onAddWorkspaceFolder: () => void;
  activeFilePath: string | null;
  onOpenFile: (rootPath: string, relPath: string) => void;
  gitStatus: GitStatus | null;
  gitLoading: boolean;
  onRefreshGit: () => void;
  onOpenDiff: (file: GitFileChange) => void;
  onFileContextMenu: (e: React.MouseEvent, file: GitFileChange) => void;
  activeDiffPath: string | null;
  sessions: SessionInfo[];
  sessionsLoading: boolean;
  activeSessionId: string | null;
  onRefreshSessions: () => void;
  onResumeSession: (session: SessionInfo) => void;
  teamHistory: TeamHistoryEntry[];
  onResumeTeam: (entry: TeamHistoryEntry) => void;
  onDeleteTeamHistory: (id: string) => void;
  recentProjects: string[];
  onNewProject: () => void;
  onOpenFolder: () => void;
  onOpenFileDialog: () => void;
  onOpenRecent: (path: string) => void;
  onClearRecent: () => void;
  onOpenSettings: () => void;
}

export function Sidebar(props: SidebarProps): JSX.Element {
  const t = useT();
  const projectName = props.projectRoot.split(/[\\/]/).filter(Boolean).pop() ?? t('appMenu.title');
  const totalHistory = props.sessions.length + props.teamHistory.length;
  const changeCount = props.gitStatus?.ok ? props.gitStatus.files.length : 0;

  const navItems: Array<{
    view: SidebarView;
    label: string;
    count?: number;
    icon: JSX.Element;
  }> = [
    {
      view: 'files',
      label: t('sidebar.files'),
      icon: <Files size={15} strokeWidth={1.85} />
    },
    {
      view: 'changes',
      label: t('sidebar.changes'),
      count: changeCount > 0 ? changeCount : undefined,
      icon: <GitBranch size={15} strokeWidth={1.85} />
    },
    {
      view: 'sessions',
      label: t('sidebar.history'),
      count: totalHistory > 0 ? totalHistory : undefined,
      icon: <History size={15} strokeWidth={1.85} />
    }
  ];

  return (
    <aside className="sidebar">
      <div className="sidebar__header">
        <AppMenu
          recentProjects={props.recentProjects}
          onNewProject={props.onNewProject}
          onOpenFolder={props.onOpenFolder}
          onOpenFile={props.onOpenFileDialog}
          onAddToWorkspace={props.onAddWorkspaceFolder}
          onOpenRecent={props.onOpenRecent}
          onClearRecent={props.onClearRecent}
        />
        <div className="sidebar__brand" title={props.projectRoot || projectName}>
          <span>vibe-editor</span>
          <span className="sidebar__brand-project">{projectName}</span>
        </div>
      </div>

      <nav className="sidebar-switcher" role="tablist" aria-label="Sidebar view">
        {navItems.map((item) => {
          const active = props.view === item.view;
          return (
            <button
              key={item.view}
              type="button"
              role="tab"
              aria-selected={active}
              aria-current={active ? 'page' : undefined}
              className={`sidebar-switcher__btn ${active ? 'is-active' : ''}`}
              onClick={() => props.onViewChange(item.view)}
            >
              <span className="sidebar-switcher__btn-icon" aria-hidden="true">
                {item.icon}
              </span>
              <span className="sidebar-switcher__btn-label">{item.label}</span>
              {item.count ? (
                <span className="sidebar-switcher__badge">
                  {item.count > 99 ? '99+' : item.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      <div className="sidebar__body" key={props.view}>
        {props.view === 'files' ? (
          <FileTreePanel
            primaryRoot={props.projectRoot}
            extraRoots={props.workspaceFolders}
            activeFilePath={props.activeFilePath}
            onOpenFile={props.onOpenFile}
            onAddWorkspaceFolder={props.onAddWorkspaceFolder}
            onRemoveWorkspaceFolder={props.onRemoveWorkspaceFolder}
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
            teamHistory={props.teamHistory}
            onResumeTeam={props.onResumeTeam}
            onDeleteTeamHistory={props.onDeleteTeamHistory}
          />
        )}
      </div>

      <UserMenu onOpenSettings={props.onOpenSettings} />
    </aside>
  );
}

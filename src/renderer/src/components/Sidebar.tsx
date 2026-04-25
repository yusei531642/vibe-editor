import type {
  GitFileChange,
  GitStatus,
  SessionInfo,
  TeamHistoryEntry
} from '../../../types/shared';
import { ChangesPanel } from './ChangesPanel';
import { SessionsPanel } from './SessionsPanel';
import { FileTreePanel } from './FileTreePanel';
import { NotesPanel } from './NotesPanel';
import { UserMenu } from './UserMenu';

export type SidebarView = 'files' | 'changes' | 'sessions' | 'notes';

interface SidebarProps {
  view: SidebarView;
  /** Sidebar 内ではビュー切替はせず Rail が担当するため未使用。型互換のため残置。 */
  onViewChange?: (view: SidebarView) => void;
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
  onOpenSettings: () => void;
}

export function Sidebar(props: SidebarProps): JSX.Element {
  return (
    <aside className="sidebar">
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
        ) : props.view === 'notes' ? (
          <NotesPanel />
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

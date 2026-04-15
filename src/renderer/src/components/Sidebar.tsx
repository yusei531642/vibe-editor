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
import { useT } from '../lib/i18n';

export type SidebarView = 'files' | 'changes' | 'sessions';

interface SidebarProps {
  view: SidebarView;
  onViewChange: (view: SidebarView) => void;

  // files view
  projectRoot: string;
  /**
   * Issue #4: プライマリの `projectRoot` に加えて並べて表示するセカンダリルート。
   * VSCode の "フォルダーをワークスペースに追加" 相当。
   */
  workspaceFolders: string[];
  onRemoveWorkspaceFolder: (path: string) => void;
  onAddWorkspaceFolder: () => void;
  activeFilePath: string | null;
  onOpenFile: (rootPath: string, relPath: string) => void;

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

  // team history (sessions view 内)
  teamHistory: TeamHistoryEntry[];
  onResumeTeam: (entry: TeamHistoryEntry) => void;
  onDeleteTeamHistory: (id: string) => void;

  // Issue #6: ハンバーガーメニュー(AppMenu)をサイドバーに配置するために渡す
  recentProjects: string[];
  onNewProject: () => void;
  onOpenFolder: () => void;
  onOpenFileDialog: () => void;
  onOpenRecent: (path: string) => void;
  onClearRecent: () => void;
}

export function Sidebar(props: SidebarProps): JSX.Element {
  const t = useT();
  return (
    <aside className="sidebar">
      <div className="sidebar__header">
        {/* Issue #6: ハンバーガー(AppMenu)はメインヘッダーからこちらへ移動 */}
        <AppMenu
          recentProjects={props.recentProjects}
          onNewProject={props.onNewProject}
          onOpenFolder={props.onOpenFolder}
          onOpenFile={props.onOpenFileDialog}
          onAddToWorkspace={props.onAddWorkspaceFolder}
          onOpenRecent={props.onOpenRecent}
          onClearRecent={props.onClearRecent}
        />
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
          {(props.sessions.length + props.teamHistory.length) > 0 && (
            <span className="sidebar-switcher__badge">
              {props.sessions.length + props.teamHistory.length}
            </span>
          )}
        </button>
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
    </aside>
  );
}

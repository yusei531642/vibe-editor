import { useCallback, useMemo } from 'react';
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
import { useSettings } from '../lib/settings-context';

/** Issue #250: FileTreePanel と同じ NUL 区切りキー (`<rootPath>\0<relPath>`) */
const KEY_SEP = '\0';

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
  const { settings, update } = useSettings();

  // Issue #250: 永続化された展開状態を Set<NULキー> に展開して FileTreePanel に渡す。
  // useMemo は settings の参照変動 (200ms debounce save 後の context 更新) で再計算される。
  const initialExpanded = useMemo(() => {
    const set = new Set<string>();
    const map = settings.fileTreeExpanded ?? {};
    for (const [root, rels] of Object.entries(map)) {
      for (const rel of rels) {
        set.add(`${root}${KEY_SEP}${rel}`);
      }
    }
    return set;
  }, [settings.fileTreeExpanded]);

  const initialCollapsedRoots = useMemo(
    () => new Set(settings.fileTreeCollapsedRoots ?? []),
    [settings.fileTreeCollapsedRoots]
  );

  const handlePersistFileTreeState = useCallback(
    ({ expanded, collapsedRoots }: { expanded: Set<string>; collapsedRoots: Set<string> }) => {
      const map: Record<string, string[]> = {};
      for (const key of expanded) {
        const sep = key.indexOf(KEY_SEP);
        if (sep <= 0) continue;
        const root = key.slice(0, sep);
        const rel = key.slice(sep + 1);
        (map[root] ??= []).push(rel);
      }
      // settings-context 内で 200ms debounce → atomic_write されるので二重 debounce 不要。
      void update({
        fileTreeExpanded: map,
        fileTreeCollapsedRoots: Array.from(collapsedRoots)
      });
    },
    [update]
  );

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
            initialExpanded={initialExpanded}
            initialCollapsedRoots={initialCollapsedRoots}
            onPersistState={handlePersistFileTreeState}
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

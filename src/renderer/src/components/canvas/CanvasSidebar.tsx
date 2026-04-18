/**
 * CanvasSidebar — Canvas モードでも IDE と同じ <Sidebar> を表示する。
 * クリックハンドラだけ Canvas Card 追加に差し替え、見た目とタブ構造は完全共通。
 */
import { useCallback, useEffect, useState } from 'react';
import type {
  GitStatus,
  SessionInfo,
  TeamHistoryEntry
} from '../../../../types/shared';
import { Sidebar, type SidebarView } from '../Sidebar';
import { useCanvasStore } from '../../stores/canvas';
import { useSettings } from '../../lib/settings-context';
import { useUiStore } from '../../stores/ui';
import { ROLE_META } from '../../lib/team-roles';

export function CanvasSidebar(): JSX.Element {
  const { settings, update } = useSettings();
  // Issue #23: projectRoot は「現在開いているプロジェクト」= lastOpenedRoot を優先。
  // claudeCwd は Claude CLI 起動時の作業ディレクトリ設定 (別用途) としてだけ使う。
  // lastOpenedRoot が空 (初回) のときだけ claudeCwd にフォールバック。
  const projectRoot = settings.lastOpenedRoot || settings.claudeCwd || '';
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);

  const addCard = useCanvasStore((s) => s.addCard);
  const addCards = useCanvasStore((s) => s.addCards);

  const [view, setView] = useState<SidebarView>('files');
  const [workspaceFolders, setWorkspaceFolders] = useState<string[]>(
    settings.workspaceFolders ?? []
  );
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [teamHistory, setTeamHistory] = useState<TeamHistoryEntry[]>([]);
  const [recentProjects, setRecentProjects] = useState<string[]>(
    settings.recentProjects ?? []
  );

  useEffect(() => {
    setWorkspaceFolders(settings.workspaceFolders ?? []);
    setRecentProjects(settings.recentProjects ?? []);
  }, [settings.workspaceFolders, settings.recentProjects]);

  const refreshGit = useCallback(async (): Promise<void> => {
    if (!projectRoot) return;
    setGitLoading(true);
    try {
      setGitStatus(await window.api.git.status(projectRoot));
    } catch (err) {
      console.warn('[canvas-sidebar] git.status failed:', err);
    } finally {
      setGitLoading(false);
    }
  }, [projectRoot]);

  const refreshSessions = useCallback(async (): Promise<void> => {
    if (!projectRoot) return;
    setSessionsLoading(true);
    try {
      setSessions(await window.api.sessions.list(projectRoot));
      setTeamHistory(await window.api.teamHistory.list(projectRoot));
    } catch (err) {
      console.warn('[canvas-sidebar] sessions.list failed:', err);
    } finally {
      setSessionsLoading(false);
    }
  }, [projectRoot]);

  useEffect(() => {
    void refreshGit();
    void refreshSessions();
  }, [refreshGit, refreshSessions]);

  // ---- Canvas-aware open handlers ----
  const handleOpenFile = useCallback(
    (rootPath: string, relPath: string): void => {
      addCard({
        type: 'editor',
        title: relPath.split(/[\\/]/).pop() ?? relPath,
        payload: { projectRoot: rootPath, relPath }
      });
    },
    [addCard]
  );

  const handleOpenDiff = useCallback(
    (file: { path: string }): void => {
      addCard({
        type: 'diff',
        title: `Δ ${file.path.split(/[\\/]/).pop() ?? file.path}`,
        // Issue #19: rename なら HEAD 側パスも伝える
        payload: { projectRoot, relPath: file.path, originalRelPath: file.originalPath }
      });
    },
    [addCard, projectRoot]
  );

  const handleResumeSession = useCallback(
    (session: SessionInfo): void => {
      addCard({
        type: 'terminal',
        title: `Resume ${session.id.slice(0, 8)}`,
        payload: { resumeSessionId: session.id, cwd: projectRoot }
      });
    },
    [addCard, projectRoot]
  );

  const handleResumeTeam = useCallback(
    (entry: TeamHistoryEntry): void => {
      const cwd = projectRoot || entry.projectRoot;
      const cards = entry.members.map((m, i) => {
        const agentId = `${m.role}-${i}-${entry.id}`;
        const saved = entry.canvasState?.nodes.find((s) => s.agentId === agentId);
        const pos = saved
          ? { x: saved.x, y: saved.y }
          : { x: (i % 3) * 520, y: Math.floor(i / 3) * 360 };
        return {
          type: 'agent' as const,
          title: ROLE_META[m.role].label,
          position: pos,
          payload: { agent: m.agent, role: m.role, teamId: entry.id, agentId, cwd }
        };
      });
      addCards(cards);
      void window.api.app
        .setupTeamMcp(
          cwd,
          entry.id,
          entry.name,
          entry.members.map((m, i) => ({
            agentId: `${m.role}-${i}-${entry.id}`,
            role: m.role,
            agent: m.agent
          }))
        )
        .catch((err) => console.warn('[resume-team] setupTeamMcp failed:', err));
    },
    [addCards, projectRoot]
  );

  const handleDeleteTeamHistory = useCallback(
    async (id: string): Promise<void> => {
      try {
        await window.api.teamHistory.delete(id);
        setTeamHistory((prev) => prev.filter((t) => t.id !== id));
      } catch (err) {
        console.warn('[canvas-sidebar] team-history delete failed:', err);
      }
    },
    []
  );

  // ---- Project / workspace folder handlers (永続化は settings.update 経由) ----
  const pushRecent = useCallback(
    async (path: string): Promise<void> => {
      const next = [path, ...recentProjects.filter((p) => p !== path)].slice(0, 12);
      setRecentProjects(next);
      // Issue #23: 開いたフォルダは lastOpenedRoot に記録する。
      // claudeCwd は Claude CLI の作業ディレクトリ設定 (別の意味) なので上書きしない。
      await update({ recentProjects: next, lastOpenedRoot: path });
    },
    [recentProjects, update]
  );

  const handleNewProject = useCallback(async () => {
    const picked = await window.api.dialog.openFolder('新規プロジェクト');
    if (picked) await pushRecent(picked);
  }, [pushRecent]);

  const handleOpenFolder = useCallback(async () => {
    const picked = await window.api.dialog.openFolder('フォルダを開く');
    if (picked) await pushRecent(picked);
  }, [pushRecent]);

  const handleOpenFileDialog = useCallback(async () => {
    const picked = await window.api.dialog.openFile('ファイルを開く');
    if (picked) {
      const dir = picked.replace(/[\\/][^\\/]+$/, '');
      const name = picked.slice(dir.length + 1);
      handleOpenFile(dir, name);
    }
  }, [handleOpenFile]);

  const handleAddWorkspaceFolder = useCallback(async () => {
    const picked = await window.api.dialog.openFolder('ワークスペースに追加');
    if (!picked) return;
    if (workspaceFolders.includes(picked)) return;
    const next = [...workspaceFolders, picked];
    setWorkspaceFolders(next);
    await update({ workspaceFolders: next });
  }, [workspaceFolders, update]);

  const handleRemoveWorkspaceFolder = useCallback(
    async (path: string) => {
      const next = workspaceFolders.filter((p) => p !== path);
      setWorkspaceFolders(next);
      await update({ workspaceFolders: next });
    },
    [workspaceFolders, update]
  );

  const handleOpenRecent = useCallback(
    async (path: string) => {
      await pushRecent(path);
    },
    [pushRecent]
  );

  const handleClearRecent = useCallback(async () => {
    setRecentProjects([]);
    await update({ recentProjects: [] });
  }, [update]);

  return (
    <Sidebar
      view={view}
      onViewChange={setView}
      projectRoot={projectRoot}
      workspaceFolders={workspaceFolders}
      onRemoveWorkspaceFolder={(p) => void handleRemoveWorkspaceFolder(p)}
      onAddWorkspaceFolder={() => void handleAddWorkspaceFolder()}
      activeFilePath={null}
      onOpenFile={handleOpenFile}
      gitStatus={gitStatus}
      gitLoading={gitLoading}
      onRefreshGit={() => void refreshGit()}
      onOpenDiff={handleOpenDiff}
      onFileContextMenu={() => {
        /* Canvas モードではコンテキストメニュー未対応 */
      }}
      activeDiffPath={null}
      sessions={sessions}
      sessionsLoading={sessionsLoading}
      activeSessionId={null}
      onRefreshSessions={() => void refreshSessions()}
      onResumeSession={handleResumeSession}
      teamHistory={teamHistory}
      onResumeTeam={handleResumeTeam}
      onDeleteTeamHistory={(id) => void handleDeleteTeamHistory(id)}
      recentProjects={recentProjects}
      onNewProject={() => void handleNewProject()}
      onOpenFolder={() => void handleOpenFolder()}
      onOpenFileDialog={() => void handleOpenFileDialog()}
      onOpenRecent={(p) => void handleOpenRecent(p)}
      onClearRecent={() => void handleClearRecent()}
      onOpenSettings={() => setSettingsOpen(true)}
    />
  );
}

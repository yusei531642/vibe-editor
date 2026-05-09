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
import { useT } from '../../lib/i18n';
import { useUiStore } from '../../stores/ui';
import { ROLE_META } from '../../lib/team-roles';
import { useFilesChanged } from '../../lib/use-files-changed';
import { spawnTeam, type SpawnTeamMember } from '../../lib/canvas-team-spawn';

interface CanvasSidebarProps {
  /** 外部 (CanvasLayout の Rail) から制御したい場合に渡す。省略時はローカル state */
  view?: SidebarView;
  onViewChange?: (v: SidebarView) => void;
  /** 親で gitStatus の変更件数を表示する用のコールバック */
  onChangeCount?: (n: number) => void;
  /** プロジェクトが git リポジトリかどうかを親に通知 (Rail から Changes タブを外す用) */
  onGitOk?: (ok: boolean) => void;
}

export function CanvasSidebar({
  view: viewProp,
  onViewChange,
  onChangeCount,
  onGitOk
}: CanvasSidebarProps = {}): JSX.Element {
  const { settings, update } = useSettings();
  const t = useT();
  // Issue #23: projectRoot は「現在開いているプロジェクト」= lastOpenedRoot を優先。
  // claudeCwd は Claude CLI 起動時の作業ディレクトリ設定 (別用途) としてだけ使う。
  // lastOpenedRoot が空 (初回) のときだけ claudeCwd にフォールバック。
  const projectRoot = settings.lastOpenedRoot || settings.claudeCwd || '';
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);

  const addCard = useCanvasStore((s) => s.addCard);
  const addCards = useCanvasStore((s) => s.addCards);

  const [localView, setLocalView] = useState<SidebarView>('files');
  const view = viewProp ?? localView;
  const setView = onViewChange ?? setLocalView;
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
  // Issue #128: 外部からの変更を検知して git status を再取得 (Sidebar Changes バッジを最新化)
  useFilesChanged(() => {
    void refreshGit();
  });

  // 親 (CanvasLayout) の Rail バッジに件数を通知
  useEffect(() => {
    onChangeCount?.(gitStatus?.ok ? gitStatus.files.length : 0);
    // git リポジトリかどうかも上に通知。null (取得前) は表示維持のため true 扱い。
    onGitOk?.(gitStatus === null ? true : gitStatus.ok);
  }, [gitStatus, onChangeCount, onGitOk]);

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
    async (entry: TeamHistoryEntry): Promise<void> => {
      const cwd = projectRoot || entry.projectRoot;
      // Issue #611 / #612: 旧実装は 520x360 hardcode grid + placeBatchAwayFromNodes
      //   未経由 + latestHandoff 未同梱で、現行 NODE_W/NODE_H (#497) と不整合のうえ
      //   既存カードと重なって配置されていた。CanvasLayout.applyPreset / restoreRecent
      //   と完全に同じ spawnTeam helper 経由に統一して、配置 / setupTeamMcp / payload
      //   同梱の責務を 1 関数に集約する。
      const members: SpawnTeamMember[] = entry.members.map((m, i) => {
        const fallbackAgentId = m.agentId ?? `${m.role}-${i}-${entry.id}`;
        const saved = entry.canvasState?.nodes.find((s) => s.agentId === fallbackAgentId);
        const savedX =
          typeof saved?.x === 'number' && Number.isFinite(saved.x) ? saved.x : null;
        const savedY =
          typeof saved?.y === 'number' && Number.isFinite(saved.y) ? saved.y : null;
        // saved 座標が無いとき、helper が placeBatchAwayFromNodes で空き地を探すので
        // ここでは「衝突しがちでも仮置きの (0,0) ベース」で十分。
        const position =
          savedX !== null && savedY !== null ? { x: savedX, y: savedY } : { x: 0, y: 0 };
        return {
          role: m.role,
          agent: m.agent,
          position,
          // Issue #69: 未知 role (旧バージョン / 手編集の team-history) でもクラッシュさせない
          title: ROLE_META[m.role]?.label ?? m.role ?? 'Agent',
          resumeSessionId: m.sessionId ?? null,
          // legacy team-history 由来の特殊 agentId は尊重する
          agentId: m.agentId ?? undefined
        };
      });
      const { cards } = await spawnTeam({
        teamId: entry.id,
        teamName: entry.name,
        cwd,
        members,
        organization: entry.organization,
        latestHandoff: entry.latestHandoff,
        existingNodes: useCanvasStore.getState().nodes,
        mcpAutoSetup: settings.mcpAutoSetup !== false,
        setupTeamMcp: window.api.app.setupTeamMcp
      });
      addCards(cards);
    },
    [addCards, projectRoot, settings.mcpAutoSetup]
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
    const picked = await window.api.dialog.openFolder(t('appMenu.newDialogTitle'));
    if (picked) await pushRecent(picked);
  }, [pushRecent, t]);

  const handleOpenFolder = useCallback(async () => {
    const picked = await window.api.dialog.openFolder(t('appMenu.openFolderDialogTitle'));
    if (picked) await pushRecent(picked);
  }, [pushRecent, t]);

  const handleOpenFileDialog = useCallback(async () => {
    const picked = await window.api.dialog.openFile(t('appMenu.openFileDialogTitle'));
    if (picked) {
      const dir = picked.replace(/[\\/][^\\/]+$/, '');
      const name = picked.slice(dir.length + 1);
      handleOpenFile(dir, name);
    }
  }, [handleOpenFile, t]);

  const handleAddWorkspaceFolder = useCallback(async () => {
    const picked = await window.api.dialog.openFolder(t('appMenu.addWorkspaceDialogTitle'));
    if (!picked) return;
    if (workspaceFolders.includes(picked)) return;
    const next = [...workspaceFolders, picked];
    setWorkspaceFolders(next);
    await update({ workspaceFolders: next });
  }, [workspaceFolders, update, t]);

  const handleRemoveWorkspaceFolder = useCallback(
    async (path: string) => {
      const isPrimary = path === projectRoot;
      if (isPrimary) {
        const name = path.split(/[\\/]/).pop() ?? path;
        if (!window.confirm(t('workspace.removePrimaryConfirm', { name }))) return;
      }
      const nextPrimary = isPrimary ? workspaceFolders.find((p) => p !== path) ?? '' : projectRoot;
      const next = workspaceFolders.filter((p) => p !== path && p !== nextPrimary);
      setWorkspaceFolders(next);
      await update({
        workspaceFolders: next,
        ...(isPrimary ? { lastOpenedRoot: nextPrimary } : {})
      });
    },
    [workspaceFolders, projectRoot, update, t]
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
      onResumeTeam={(entry) => void handleResumeTeam(entry)}
      onDeleteTeamHistory={(id) => void handleDeleteTeamHistory(id)}
      onOpenSettings={() => setSettingsOpen(true)}
    />
  );
}

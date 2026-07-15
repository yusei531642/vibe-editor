import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GitStatus, SessionInfo } from '../../../../types/shared';
import { useT } from '../i18n';
import { useNativeConfirm } from '../use-native-confirm';
import {
  useSettingsActions,
  useSettingsLoading,
  useSettingsValue
} from '../settings-context';
import { useUiStore } from '../../stores/ui';
import { dedupPrepend, listContainsPath } from '../path-norm';
import { reportRefreshFailure } from '../refresh-error';

type ToastFn = (
  msg: string,
  opts?: { tone?: 'info' | 'success' | 'warning' | 'error' }
) => void;

export interface UseProjectLoaderOptions {
  /** 既存タブの discard 確認。返り値が false ならプロジェクト切替を中止する。
   *  Phase 1-2 (use-file-tabs) 抽出までの一時的注入。 */
  confirmDiscardEditorTabs: () => Promise<boolean>;
  /** loadProject によりプロジェクトが切り替わった直後に呼ばれる。
   *  App.tsx 側で editor tabs / sessions / teams / terminal tabs を初期化するために使う。
   *  Phase 1-2 〜 1-4 で各 hook に分散したら順次 opts から削る。 */
  onProjectSwitched: (root: string) => void;
  /** loadProject / 初回ロード effect で取得した snapshot を上に流す。
   *  hook が責務外として保持しない state (sessions など) を親に伝える橋渡し。 */
  onLoaded: (snapshot: { gitStatus: GitStatus; sessions: SessionInfo[] }) => void;
  /** Phase 2 (Issue #487): プロジェクトメニュー / ワークスペース系 handler 移管に伴い追加。
   *  toast はこの hook 内で表示する (UI 配線を呼び出し側に分散させない)。 */
  showToast: ToastFn;
  /** Phase 2 (Issue #487): handleRemoveWorkspaceFolder で「rootPath = path のエディタ
   *  タブを破棄する」ためのブリッジ。dirty タブがあるときはユーザー確認を取り、OK なら
   *  setEditorTabs で当該タブを閉じる。返り値が false の場合 (= ユーザーが Cancel)、
   *  hook 側は workspaceFolders を変更してはならない (Issue #33 と同じ約束)。 */
  discardEditorTabsForRoot: (rootPath: string) => Promise<boolean>;
}

export interface UseProjectLoaderResult {
  projectRoot: string;
  loadProject: (
    root: string,
    options?: { addToRecent?: boolean }
  ) => Promise<boolean>;
  refreshGit: () => Promise<void>;
  gitStatus: GitStatus | null;
  gitLoading: boolean;

  // ---- Phase 2 (Issue #487): プロジェクトメニュー / ワークスペース系 ----
  /** projectRoot を除いたユーザー登録ワークスペース一覧。Sidebar に渡す。 */
  workspaceFolders: string[];
  handleNewProject: () => Promise<void>;
  handleOpenFolder: () => Promise<void>;
  handleOpenFile: () => Promise<void>;
  handleOpenRecent: (path: string) => Promise<void>;
  handleClearRecent: () => void;
  handleAddWorkspaceFolder: () => Promise<void>;
  handleRemoveWorkspaceFolder: (path: string) => Promise<void>;
}

export function useProjectLoader(
  opts: UseProjectLoaderOptions
): UseProjectLoaderResult {
  const settingsLoading = useSettingsLoading();
  const { update: updateSettings } = useSettingsActions();
  const lastOpenedRoot = useSettingsValue('lastOpenedRoot');
  const recentProjects = useSettingsValue('recentProjects');
  const hasCompletedOnboarding = useSettingsValue('hasCompletedOnboarding');
  const mcpAutoSetup = useSettingsValue('mcpAutoSetup');
  const t = useT();
  const confirm = useNativeConfirm();

  const [projectRoot, setProjectRoot] = useState<string>('');
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [gitLoading, setGitLoading] = useState<boolean>(true);

  // opts は ref に詰めて useCallback の deps から外す (use-pty-session.ts と同じ流儀)。
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const loadProject = useCallback(
    async (
      root: string,
      options: { addToRecent?: boolean } = { addToRecent: true }
    ): Promise<boolean> => {
      // Issue #1193: root はこの関数の前にnative picker commandがRust側でactive化済み。
      // rendererのraw pathはauthorityにならず、以後のgit/files IPCもbackend gateで照合される。
      setProjectRoot(root);
      useUiStore.getState().setStatus(t('project.loading'));
      setGitLoading(true);

      try {
        const [gs, sess] = await Promise.all([
          window.api.git.status(root),
          window.api.sessions.list(root)
        ]);
        // MCP 初期化は await する（新規タブ spawn より前に claude.json を確定）
        // settings.mcpAutoSetup === false の場合は MCP 自動書換を全てスキップする
        if (mcpAutoSetup !== false) {
          try {
            await window.api.app.setupTeamMcp(root, '_init', '', []);
          } catch (err) {
            console.warn('[loadProject] setupTeamMcp failed:', err);
          }
        }

        setGitStatus(gs);
        optsRef.current.onLoaded({ gitStatus: gs, sessions: sess });
        // タブ・セッション・チーム・ターミナル等の reset は親に外注。
        optsRef.current.onProjectSwitched(root);
        useUiStore.getState().setStatus(`${root.split(/[\\/]/).pop()}`);
        // ここでは runtime の「最後に開いたルート」のみ永続化する。
        // `claudeCwd` は SettingsModal で設定されるユーザー設定のため上書き厳禁。
        if (options.addToRecent !== false) {
          const rp = recentProjects ?? [];
          // Issue #67: path を raw 比較すると表記揺れで重複エントリが増える。
          // normalize 後キーで dedup。
          const next = dedupPrepend(rp, root, 10);
          void updateSettings({ recentProjects: next, lastOpenedRoot: root });
        } else {
          void updateSettings({ lastOpenedRoot: root });
        }
        return true;
      } catch (err) {
        // native pickerはbackend authorityを先に切り替える。後続の初期化に失敗したまま
        // 旧UIを残すとbackend/UIが別projectを指すため、active rootをfail-closedで解除する。
        await window.api.app.clearActiveProjectRoot().catch(() => undefined);
        setProjectRoot('');
        setGitStatus(null);
        optsRef.current.onProjectSwitched('');
        useUiStore.getState().setStatus(t('project.loadError', { error: String(err) }));
        return false;
      } finally {
        setGitLoading(false);
      }
    },
    [projectRoot, mcpAutoSetup, recentProjects, updateSettings, t]
  );

  const pickAndLoadProject = useCallback(
    async (
      title: string,
      options: { addToRecent?: boolean } = { addToRecent: true }
    ): Promise<boolean> => {
      // native pickerのcancel前に未保存タブを守る。picker成功後にbackend authorityが切り替わるため、
      // 確認は先に済ませる。
      if (projectRoot && !(await optsRef.current.confirmDiscardEditorTabs())) return false;
      const root = await window.api.app.pickAndActivateProjectRoot(title);
      if (!root) return false;
      return loadProject(root, options);
    },
    [loadProject, projectRoot]
  );

  // 初回ロード — lastOpenedRoot (前回開いたルート) があれば復元、なければフォルダ選択ダイアログ。
  // 以前は process.cwd() に fallback していたが、インストール版だと vibe-editor 自身の
  // インストールディレクトリが選ばれてしまう。明示的にユーザーに選んでもらう。
  // Onboarding 未完了時は Onboarding 側でルートを選ばせるため、ここでは何もしない。
  const didInitRef = useRef(false);
  useEffect(() => {
    if (settingsLoading) return;
    if (didInitRef.current) return;
    if (!hasCompletedOnboarding) return;
    didInitRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        // Issue #1193: settings.lastOpenedRoot / claudeCwd はrendererが更新できるため、
        // 起動時のauthorityに使わない。Rustのprivate ledgerが復元したactive rootだけを使う。
        let root = await window.api.app.restoreAuthorizedProjectRoot();
        if (!root) {
          // settingsの保存値はauthorityには使わず、native pickerの初期位置にだけ渡す。
          const picked = lastOpenedRoot
            ? await window.api.app.reconfirmProjectRoot(
                lastOpenedRoot,
                t('appMenu.openFolderDialogTitle')
              )
            : await window.api.app.pickAndActivateProjectRoot(
                t('appMenu.openFolderDialogTitle')
              );
          if (cancelled) return;
          if (!picked) {
            // ユーザーがキャンセルした場合は projectRoot 未設定のまま空状態を維持。
            // 上部の AppMenu / コマンドパレットから後で開けるようにしておく。
            useUiStore.getState().setStatus(t('status.noProject'));
            setGitLoading(false);
            return;
          }
          root = picked;
        }
        if (cancelled) return;
        setProjectRoot(root);
        if (root !== lastOpenedRoot) {
          void updateSettings({ lastOpenedRoot: root });
        }
        const [gs, sess] = await Promise.all([
          window.api.git.status(root),
          window.api.sessions.list(root)
        ]);
        // MCP 初期化は await する（新規タブ spawn より前に claude.json を確定）
        if (mcpAutoSetup !== false) {
          try {
            await window.api.app.setupTeamMcp(root, '_init', '', []);
          } catch (err) {
            console.warn('[init] setupTeamMcp failed:', err);
          }
        }
        if (cancelled) return;
        setGitStatus(gs);
        setGitLoading(false);
        optsRef.current.onLoaded({ gitStatus: gs, sessions: sess });
        useUiStore.getState().setStatus(root.split(/[\\/]/).pop() ?? root);
      } catch (err) {
        // git/sessionの一時的な初期化失敗は、native承認済みauthorityを失効させる理由ではない。
        // rootを保持し、ユーザーが再読込または別folder選択で復旧できる状態にする。
        setGitStatus(null);
        useUiStore.getState().setStatus(t('project.initError', { error: String(err) }));
        setGitLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsLoading, hasCompletedOnboarding]);

  // タイトルバー
  useEffect(() => {
    const name = projectRoot.split(/[\\/]/).pop() || 'vibe-editor';
    window.api.app.setWindowTitle(`vibe-editor — ${name}`).catch(() => undefined);
  }, [projectRoot]);

  const refreshGit = useCallback(async () => {
    if (!projectRoot) return;
    setGitLoading(true);
    try {
      const gs = await window.api.git.status(projectRoot);
      setGitStatus(gs);
    } catch (err) {
      reportRefreshFailure(
        'git.status',
        err,
        t('toast.gitRefreshFailed'),
        optsRef.current.showToast
      );
    } finally {
      setGitLoading(false);
    }
  }, [projectRoot, t]);

  // ---- Phase 2 (Issue #487): プロジェクトメニュー / ワークスペース ----

  // Issue #67: 比較を normalize 後キーで行い、表記揺れ (大小文字 / `\` vs `/`) を吸収。
  // projectRoot 自体は別 UI 上 (Sidebar header) で表示されるので一覧からは除外する。
  const workspaceFoldersFromSettings = useSettingsValue('workspaceFolders');
  const workspaceFolders = useMemo(
    () =>
      (workspaceFoldersFromSettings ?? []).filter(
        (p) => p && p !== projectRoot
      ),
    [workspaceFoldersFromSettings, projectRoot]
  );

  const handleNewProject = useCallback(async () => {
    if (projectRoot && !(await optsRef.current.confirmDiscardEditorTabs())) return;
    const folder = await window.api.app.pickAndActivateProjectRoot(
      t('project.newDialogTitle')
    );
    if (!folder) return;
    let empty: boolean;
    try {
      empty = await window.api.dialog.isFolderEmpty(folder);
    } catch (err) {
      await window.api.app.clearActiveProjectRoot().catch(() => undefined);
      useUiStore.getState().setStatus(t('project.loadError', { error: String(err) }));
      return;
    }
    const loaded = await loadProject(folder);
    if (!loaded) return;
    if (!empty) {
      optsRef.current.showToast(t('project.newFolderNotEmpty'), {
        tone: 'warning'
      });
    } else {
      optsRef.current.showToast(t('project.created'), { tone: 'success' });
    }
  }, [loadProject, projectRoot, t]);

  const handleOpenFolder = useCallback(async () => {
    await pickAndLoadProject(t('project.openExistingDialogTitle'));
  }, [pickAndLoadProject, t]);

  const handleOpenFile = useCallback(async () => {
    if (projectRoot && !(await optsRef.current.confirmDiscardEditorTabs())) return;
    const picked = await window.api.app.pickFileAndActivateProjectRoot(
      t('appMenu.openFileDialogTitle')
    );
    if (!picked) return;
    const loaded = await loadProject(picked.projectRoot);
    if (loaded) {
      optsRef.current.showToast(
        t('project.fileParentLoaded', { file: picked.filePath }),
        { tone: 'info' }
      );
    }
  }, [loadProject, projectRoot, t]);

  const handleOpenRecent = useCallback(
    async (path: string) => {
      // recentProjects は表示用の履歴であり、raw pathを再有効化する能力ではない。
      if (projectRoot && !(await optsRef.current.confirmDiscardEditorTabs())) return;
      const root = await window.api.app.reconfirmProjectRoot(
        path,
        t('project.openExistingDialogTitle')
      );
      if (root) await loadProject(root);
    },
    [loadProject, projectRoot, t]
  );

  const handleClearRecent = useCallback(() => {
    void updateSettings({ recentProjects: [] });
    optsRef.current.showToast(t('project.recentCleared'), {
      tone: 'info'
    });
  }, [updateSettings, t]);

  const handleAddWorkspaceFolder = useCallback(async () => {
    const folder = await window.api.app.pickWorkspaceRoot(
      t('appMenu.addWorkspaceDialogTitle')
    );
    if (!folder) return;
    const name = folder.split(/[\\/]/).pop() ?? folder;
    // Issue #67: 比較を normalize 後キーで行い、表記揺れ (大小文字 / `\` vs `/`) を吸収。
    if (listContainsPath([projectRoot], folder)) {
      optsRef.current.showToast(t('workspace.alreadyAdded', { name }), {
        tone: 'info'
      });
      return;
    }
    const current = workspaceFoldersFromSettings ?? [];
    if (listContainsPath(current, folder)) {
      optsRef.current.showToast(t('workspace.alreadyAdded', { name }), {
        tone: 'info'
      });
      return;
    }
    await updateSettings({ workspaceFolders: [...current, folder] });
    optsRef.current.showToast(t('workspace.added', { name }), { tone: 'success' });
  }, [workspaceFoldersFromSettings, projectRoot, updateSettings, t]);

  const handleRemoveWorkspaceFolder = useCallback(
    async (path: string) => {
      const current = workspaceFoldersFromSettings ?? [];
      const isPrimary = path === projectRoot;
      if (!isPrimary && !current.includes(path)) return;
      const name = path.split(/[\\/]/).pop() ?? path;

      if (isPrimary && !(await confirm(t('workspace.removePrimaryConfirm', { name })))) {
        return;
      }

      // Issue #33: 未保存タブの破棄確認を settings 更新より先に行う。
      // Cancel された場合は settings / tabs どちらも変更せず、UI と永続状態の整合を保つ。
      // editor-tab 側の操作 (確認 → 閉じる) は呼び出し側の use-file-tabs 知識が必要なので
      // discardEditorTabsForRoot ブリッジ越しに委譲する。
      if (!(await optsRef.current.discardEditorTabsForRoot(path))) {
        return;
      }
      if (isPrimary) {
        const nextPrimary = current.find((p) => p !== path) ?? '';
        const nextWorkspaceFolders = current.filter((p) => p !== path && p !== nextPrimary);
        if (nextPrimary) {
          const activated = await window.api.app.activateAuthorizedWorkspaceRoot(nextPrimary);
          const loaded = await loadProject(activated);
          if (!loaded) return;
          await updateSettings({
            lastOpenedRoot: activated,
            workspaceFolders: nextWorkspaceFolders
          });
        } else {
          await window.api.app.clearActiveProjectRoot();
          setProjectRoot('');
          setGitStatus(null);
          setGitLoading(false);
          optsRef.current.onProjectSwitched('');
          useUiStore.getState().setStatus(t('status.noProject'));
          await updateSettings({
            lastOpenedRoot: '',
            workspaceFolders: nextWorkspaceFolders
          });
        }
      } else {
        await window.api.app.revokeWorkspaceRoot(path);
        await updateSettings({ workspaceFolders: current.filter((p) => p !== path) });
      }
      optsRef.current.showToast(t('workspace.removed', { name }), { tone: 'info' });
    },
    [workspaceFoldersFromSettings, projectRoot, loadProject, updateSettings, t, confirm]
  );

  return {
    projectRoot,
    loadProject,
    refreshGit,
    gitStatus,
    gitLoading,
    workspaceFolders,
    handleNewProject,
    handleOpenFolder,
    handleOpenFile,
    handleOpenRecent,
    handleClearRecent,
    handleAddWorkspaceFolder,
    handleRemoveWorkspaceFolder
  };
}

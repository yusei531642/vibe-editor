import { useCallback } from 'react';
import { useCanvasStore } from '../../stores/canvas';
import { useSettings } from '../settings-context';
import { useToast } from '../toast-context';
import { useT } from '../i18n';
import { useNativeConfirm } from '../use-native-confirm';
import { getDirtyEditorCardSnapshots } from '../editor-card-dirty-registry';
import { useProject } from '../app-state-context';

export interface CanvasMenuActions {
  handleNewProject: () => Promise<void>;
  handleOpenFolder: () => Promise<void>;
  handleOpenFile: () => Promise<void>;
  handleAddWorkspaceFolder: () => Promise<void>;
  handleOpenRecent: (path: string) => void;
  handleRestart: () => Promise<void>;
  handleCheckUpdate: () => void;
  handleClickUpdate: () => void;
  handleOpenGithub: () => void;
  clearCanvas: () => Promise<void>;
}

/**
 * Canvas モードの AppMenuBar / Topbar 操作 (workspace 系 + 再起動 + 更新 + Clear) を
 * 所有する hook。Issue #1032: CanvasLayout の god-file 分割で切り出し。
 * IDE / Canvas で同一メニューを出すため Canvas 側も同等のハンドラ群を実装する。
 * project/workspace 系はAppStateProviderの共通loaderへ委譲し、native authorityとUI stateを
 * 同じtransactionで切り替える。
 * handleOpenFile だけ Canvas 固有: Editor カードを addCard で配置する。
 */
export function useCanvasMenuActions(): CanvasMenuActions {
  const clear = useCanvasStore((s) => s.clear);
  const { settings } = useSettings();
  const {
    handleNewProject: openNewProject,
    handleOpenFolder: openFolder,
    handleAddWorkspaceFolder: addWorkspaceFolder,
    handleOpenRecent: openRecent,
    loadProject
  } = useProject();
  const { showToast, dismissToast } = useToast();
  const t = useT();
  const confirm = useNativeConfirm();

  const handleNewProject = useCallback(async () => {
    await openNewProject();
  }, [openNewProject]);

  const handleOpenFolder = useCallback(async () => {
    await openFolder();
  }, [openFolder]);

  const handleOpenFile = useCallback(async () => {
    const picked = await window.api.app.pickFileAndActivateProjectRoot(
      t('appMenu.openFileDialogTitle')
    );
    if (!picked) return;
    if (!(await loadProject(picked.projectRoot))) return;
    const name = picked.filePath.split(/[\\/]/).pop() ?? picked.filePath;
    useCanvasStore.getState().addCard({
      type: 'editor',
      title: name,
      payload: { projectRoot: picked.projectRoot, relPath: name }
    });
  }, [loadProject, t]);

  const handleAddWorkspaceFolder = useCallback(async () => {
    await addWorkspaceFolder();
  }, [addWorkspaceFolder]);

  const handleOpenRecent = useCallback(
    (path: string): void => {
      void openRecent(path);
    },
    [openRecent]
  );

  const handleRestart = useCallback(async (): Promise<void> => {
    const dirty = getDirtyEditorCardSnapshots();
    if (dirty.length > 0) {
      const paths = dirty.map((d) => `• ${d.relPath}`).join('\n');
      const message = t('canvas.clearConfirmWithDirtyEditors', {
        count: dirty.length,
        paths
      });
      if (!(await confirm(message))) return;
    }
    await window.api.app.restart();
  }, [confirm, t]);

  const handleCheckUpdate = useCallback((): void => {
    void import('../updater-check').then((m) =>
      m.checkForUpdates({
        language: settings.language,
        showToast,
        dismissToast,
        manual: true,
        // Canvas モードでは IDE の terminalTabs を持たない (タブは Canvas カード側で管理)。
        // updater 側は "0" でも問題なく動く (running task 警告が出ないだけ)。
        runningTaskCount: 0
      })
    );
  }, [settings.language, showToast, dismissToast]);

  const handleClickUpdate = useCallback((): void => {
    void import('../updater-check').then((m) =>
      m.runUpdateInstall({
        language: settings.language,
        showToast,
        dismissToast,
        manual: true
      })
    );
  }, [settings.language, showToast, dismissToast]);

  const handleOpenGithub = useCallback((): void => {
    void window.api.app.openExternal('https://github.com/yusei531642/vibe-editor');
  }, []);

  const clearCanvas = useCallback(async (): Promise<void> => {
    const dirty = getDirtyEditorCardSnapshots();
    if (dirty.length === 0) {
      if (await confirm(t('canvas.clearConfirm'))) clear();
      return;
    }
    const paths = dirty.map((d) => `• ${d.relPath}`).join('\n');
    const message = t('canvas.clearConfirmWithDirtyEditors', {
      count: dirty.length,
      paths
    });
    if (await confirm(message)) clear();
  }, [confirm, t, clear]);

  return {
    handleNewProject,
    handleOpenFolder,
    handleOpenFile,
    handleAddWorkspaceFolder,
    handleOpenRecent,
    handleRestart,
    handleCheckUpdate,
    handleClickUpdate,
    handleOpenGithub,
    clearCanvas
  };
}

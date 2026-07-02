import { useCallback } from 'react';
import { useCanvasStore } from '../../stores/canvas';
import { useSettings } from '../settings-context';
import { useToast } from '../toast-context';
import { useT } from '../i18n';
import { useNativeConfirm } from '../use-native-confirm';
import { getDirtyEditorCardSnapshots } from '../editor-card-dirty-registry';

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
 * workspace 系は settings.update で完結 (recentProjects / workspaceFolders / lastOpenedRoot)。
 * handleOpenFile だけ Canvas 固有: Editor カードを addCard で配置する。
 */
export function useCanvasMenuActions(): CanvasMenuActions {
  const clear = useCanvasStore((s) => s.clear);
  const { settings, update: updateSettings } = useSettings();
  const { showToast, dismissToast } = useToast();
  const t = useT();
  const confirm = useNativeConfirm();

  const pushRecent = useCallback(
    async (path: string): Promise<void> => {
      const next = [path, ...(settings.recentProjects ?? []).filter((p) => p !== path)].slice(0, 12);
      await updateSettings({ recentProjects: next, lastOpenedRoot: path });
    },
    [settings.recentProjects, updateSettings]
  );

  const handleNewProject = useCallback(async () => {
    const picked = await window.api.dialog.openFolder(t('appMenu.newDialogTitle'));
    if (picked) await pushRecent(picked);
  }, [pushRecent, t]);

  const handleOpenFolder = useCallback(async () => {
    const picked = await window.api.dialog.openFolder(t('appMenu.openFolderDialogTitle'));
    if (picked) await pushRecent(picked);
  }, [pushRecent, t]);

  const handleOpenFile = useCallback(async () => {
    const picked = await window.api.dialog.openFile(t('appMenu.openFileDialogTitle'));
    if (!picked) return;
    const dir = picked.replace(/[\\/][^\\/]+$/, '');
    const name = picked.slice(dir.length + 1);
    useCanvasStore.getState().addCard({
      type: 'editor',
      title: name,
      payload: { projectRoot: dir, relPath: name }
    });
  }, [t]);

  const handleAddWorkspaceFolder = useCallback(async () => {
    const picked = await window.api.dialog.openFolder(t('appMenu.addWorkspaceDialogTitle'));
    if (!picked) return;
    const current = settings.workspaceFolders ?? [];
    if (current.includes(picked)) return;
    await updateSettings({ workspaceFolders: [...current, picked] });
  }, [settings.workspaceFolders, updateSettings, t]);

  const handleOpenRecent = useCallback(
    (path: string): void => {
      void pushRecent(path);
    },
    [pushRecent]
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

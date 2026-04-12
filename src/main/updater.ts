// GitHub Releases からの自動アップデート。
// 起動時に最新版をチェックし、新版があればバックグラウンドでダウンロード。
// 完了したらダイアログで再起動確認する。dev ビルドでは無効化する。

import { app, dialog, BrowserWindow, Notification } from 'electron';
import { autoUpdater } from 'electron-updater';

let initialized = false;

function getWin(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null;
}

export function initAutoUpdater(): void {
  if (initialized) return;
  initialized = true;

  // dev ビルドでは latest.yml が無いため no-op
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (err) => {
    console.error('[auto-updater] error:', err);
    const win = getWin();
    if (win) {
      dialog.showMessageBox(win, {
        type: 'error',
        title: 'アップデートエラー',
        message: 'アップデートに失敗しました',
        detail: String(err.message || err)
      });
    }
  });

  autoUpdater.on('update-available', (info) => {
    console.log(`[auto-updater] update available: v${info.version}`);
    const win = getWin();
    if (!win) return;
    const result = dialog.showMessageBoxSync(win, {
      type: 'info',
      buttons: ['ダウンロード', '後で'],
      defaultId: 0,
      cancelId: 1,
      title: 'アップデートがあります',
      message: `vibe-editor v${info.version} が利用可能です`,
      detail: `現在のバージョン: v${app.getVersion()}\n今すぐダウンロードしますか？`
    });
    if (result === 0) {
      // ダウンロード中を通知
      if (Notification.isSupported()) {
        new Notification({
          title: 'vibe-editor',
          body: `v${info.version} をダウンロード中…`
        }).show();
      }
      autoUpdater.downloadUpdate().catch((err) => {
        console.error('[auto-updater] downloadUpdate failed:', err);
        const w = getWin();
        if (w) {
          dialog.showMessageBox(w, {
            type: 'error',
            title: 'ダウンロード失敗',
            message: 'アップデートのダウンロードに失敗しました',
            detail: String(err.message || err)
          });
        }
      });
    }
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[auto-updater] already on latest version');
  });

  autoUpdater.on('update-downloaded', (info) => {
    const win = getWin();
    if (!win) return;
    const result = dialog.showMessageBoxSync(win, {
      type: 'info',
      buttons: ['今すぐ再起動', '後で'],
      defaultId: 0,
      cancelId: 1,
      title: 'アップデート準備完了',
      message: `vibe-editor v${info.version} のダウンロードが完了しました`,
      detail: '今すぐ再起動してインストールしますか？ 「後で」を選ぶと次回終了時に自動で適用されます。'
    });
    if (result === 0) {
      autoUpdater.quitAndInstall();
    }
  });

  // 起動直後に一度だけチェック。失敗してもアプリの起動は妨げない。
  autoUpdater.checkForUpdates().catch((err) => {
    console.error('[auto-updater] checkForUpdates failed:', err);
  });
}

// GitHub Releases からの自動アップデート。
// 起動時に最新版をチェックし、新版があればバックグラウンドでダウンロード。
// 完了したらダイアログで再起動確認する。dev ビルドでは無効化する。

import { app, dialog, BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';

let initialized = false;
let updateWin: BrowserWindow | null = null;

function getWin(): BrowserWindow | null {
  return BrowserWindow.getAllWindows().find((w) => w !== updateWin) ?? null;
}

/** ダウンロード進捗を表示するウィンドウ */
function showProgressWindow(version: string): void {
  updateWin = new BrowserWindow({
    width: 420,
    height: 180,
    resizable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    frame: false,
    alwaysOnTop: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });

  updateWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body { margin:0; font-family:'Segoe UI',sans-serif; background:#1a1a2e; color:#e0e0e0;
         display:flex; flex-direction:column; justify-content:center; align-items:center; height:100vh; }
  h2 { font-size:16px; font-weight:500; margin:0 0 16px; }
  .bar-bg { width:320px; height:8px; background:#2a2a3e; border-radius:4px; overflow:hidden; }
  .bar { height:100%; width:0%; background:linear-gradient(90deg,#d97757,#e8956a); border-radius:4px;
         transition:width 0.3s; }
  .pct { margin-top:12px; font-size:13px; color:#999; }
</style></head><body>
  <h2>vibe-editor v${version} をインストール中…</h2>
  <div class="bar-bg"><div class="bar" id="bar"></div></div>
  <div class="pct" id="pct">ダウンロード中… 0%</div>
</body></html>`)}`);

  updateWin.on('closed', () => { updateWin = null; });
}

function updateProgress(percent: number): void {
  if (!updateWin || updateWin.isDestroyed()) return;
  const p = Math.round(percent);
  updateWin.webContents.executeJavaScript(
    `document.getElementById('bar').style.width='${p}%';` +
    `document.getElementById('pct').textContent='ダウンロード中… ${p}%';`
  ).catch(() => {});
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
    if (updateWin && !updateWin.isDestroyed()) {
      updateWin.destroy();
      updateWin = null;
    }
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
      buttons: ['今すぐアップデート', '後で'],
      defaultId: 0,
      cancelId: 1,
      title: 'アップデートがあります',
      message: `vibe-editor v${info.version} が利用可能です`,
      detail: `現在のバージョン: v${app.getVersion()}\nアップデートしますか？ アプリを閉じてインストールし、完了後に自動で起動します。`
    });
    if (result === 0) {
      // メインウィンドウを閉じて進捗ウィンドウを表示
      const mainWin = getWin();
      if (mainWin) mainWin.hide();
      showProgressWindow(info.version);
      autoUpdater.downloadUpdate().catch((err) => {
        console.error('[auto-updater] downloadUpdate failed:', err);
      });
    }
  });

  autoUpdater.on('download-progress', (progress) => {
    updateProgress(progress.percent);
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[auto-updater] already on latest version');
  });

  autoUpdater.on('update-downloaded', () => {
    // ダウンロード完了 → 即座にインストール＆再起動
    if (updateWin && !updateWin.isDestroyed()) {
      updateWin.webContents.executeJavaScript(
        `document.getElementById('pct').textContent='インストール中…';` +
        `document.getElementById('bar').style.width='100%';`
      ).catch(() => {});
    }
    setTimeout(() => {
      if (updateWin && !updateWin.isDestroyed()) {
        updateWin.destroy();
        updateWin = null;
      }
      autoUpdater.quitAndInstall(false, true);
    }, 500);
  });

  // 起動直後に一度だけチェック。失敗してもアプリの起動は妨げない。
  autoUpdater.checkForUpdates().catch((err) => {
    console.error('[auto-updater] checkForUpdates failed:', err);
  });
}

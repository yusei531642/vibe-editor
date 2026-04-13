import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron';
import { join } from 'path';
import { registerAppIpc } from './ipc/app';
import { registerGitIpc } from './ipc/git';
import { registerTerminalIpc } from './ipc/terminal';
import { registerSettingsIpc } from './ipc/settings';
import { registerSessionsIpc } from './ipc/sessions';
import { registerDialogIpc } from './ipc/dialog';
import { registerFilesIpc } from './ipc/files';
import { registerTeamHistoryIpc } from './ipc/team-history';
import { initAutoUpdater } from './updater';
import { teamHub } from './team-hub';

const isDev = !app.isPackaged;

// GitHub CDN (release-assets.githubusercontent.com) との TLS ハンドシェイク安定化
app.commandLine.appendSwitch('ignore-certificate-errors', 'false');
app.commandLine.appendSwitch('ssl-version-min', 'tls1.2');

// デフォルトのアプリケーションメニュー（File/Edit/View/Window/Help）を完全に削除。
// vibe coding UI にはネイティブメニューバーは不要。
Menu.setApplicationMenu(null);

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: 'vibe-editor',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow.show();
    if (isDev) {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
  if (isDev && rendererUrl) {
    mainWindow.loadURL(rendererUrl);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

// preload 疎通確認用のping
ipcMain.handle('ping', () => 'pong');

registerAppIpc();
registerGitIpc();
registerTerminalIpc();
registerSettingsIpc();
registerSessionsIpc();
registerDialogIpc();
registerFilesIpc();
registerTeamHistoryIpc();

app.whenReady().then(async () => {
  try {
    await teamHub.start();
  } catch (err) {
    console.error('[TeamHub] failed to start:', err);
  }

  createWindow();
  initAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  teamHub.stop();
});

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, navigationUrl) => {
    const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
    if (rendererUrl && navigationUrl.startsWith(rendererUrl)) return;
    event.preventDefault();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

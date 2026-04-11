import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { join } from 'path';
import { registerClaudeMdIpc } from './ipc/claude-md';
import { registerSkillsIpc } from './ipc/skills';
import { registerAppIpc } from './ipc/app';
import { registerGitIpc } from './ipc/git';
import { registerTerminalIpc } from './ipc/terminal';
import { registerSettingsIpc } from './ipc/settings';
import { registerSessionsIpc } from './ipc/sessions';
import { registerDialogIpc } from './ipc/dialog';

const isDev = !app.isPackaged;

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 640,
    show: false,
    autoHideMenuBar: false,
    title: 'claude-editor',
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

  // 外部リンクは既定ブラウザで開く
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // dev: Vite dev server、本番: ビルド済みHTMLをロード
  const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
  if (isDev && rendererUrl) {
    mainWindow.loadURL(rendererUrl);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

// preload 疎通確認用のping
ipcMain.handle('ping', () => 'pong');

// Phase 2/3/4 のIPCハンドラ群を登録
registerClaudeMdIpc();
registerSkillsIpc();
registerAppIpc();
registerGitIpc();
registerTerminalIpc();
registerSettingsIpc();
registerSessionsIpc();
registerDialogIpc();

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 外部サイトへのナビゲーションをブロック
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

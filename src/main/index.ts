import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  Tray
} from 'electron';
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

/**
 * 起動中のメインウィンドウへの参照。タスクバー(トレイ)メニューから
 * 再表示するときに使う。複数ウィンドウは想定しない。
 */
let mainWindowRef: BrowserWindow | null = null;
/** Tray インスタンス。GC されるとアイコンが消えるので globals に保持する */
let tray: Tray | null = null;
/**
 * true のときは BrowserWindow の close でアプリを実際に終了させる。
 * 通常は false で、X ボタンは「トレイに最小化」として動作する。
 */
let isQuitting = false;

/** アイコン探索: パッケージ後は resources/build 配下、開発中は repo の build/ */
function resolveIconPath(filename: string): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'build', filename);
  }
  return join(app.getAppPath(), 'build', filename);
}

function showMainWindow(): void {
  if (!mainWindowRef) {
    createWindow();
    return;
  }
  if (mainWindowRef.isMinimized()) mainWindowRef.restore();
  if (!mainWindowRef.isVisible()) mainWindowRef.show();
  mainWindowRef.focus();
}

function setupTray(): void {
  if (tray) return;
  // ICO は Windows ネイティブ、macOS/Linux は PNG を使う
  const iconPath = resolveIconPath(process.platform === 'win32' ? 'icon.ico' : 'icon-32.png');
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    // フォールバック: 32x32 PNG
    image = nativeImage.createFromPath(resolveIconPath('icon-32.png'));
  }
  tray = new Tray(image);
  tray.setToolTip('vibe-editor');

  const menu = Menu.buildFromTemplate([
    {
      label: 'vibe-editor を開く',
      click: () => showMainWindow()
    },
    { type: 'separator' },
    {
      label: '終了',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(menu);

  // 左クリック(Windows) / タップ で表示トグル
  tray.on('click', () => {
    if (mainWindowRef && mainWindowRef.isVisible() && !mainWindowRef.isMinimized()) {
      mainWindowRef.hide();
    } else {
      showMainWindow();
    }
  });
  // ダブルクリックは常に表示
  tray.on('double-click', () => showMainWindow());
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: 'vibe-editor',
    icon: resolveIconPath(process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindowRef = mainWindow;

  mainWindow.on('ready-to-show', () => {
    mainWindow.show();
    if (isDev) {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  });

  // X ボタンではアプリを終了せず、トレイに畳む。
  // - タスクバー/通知領域のトレイアイコンから「終了」を選ぶ
  // - または `app.quit()` 直前に isQuitting を true にする
  // ことで初めて実際に閉じる。
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on('closed', () => {
    if (mainWindowRef === mainWindow) {
      mainWindowRef = null;
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

// Windows のタスクバー / トレイで「すでに起動中」を識別させる AppUserModelID。
// これがないとトレイアイコンと本体ウィンドウがタスクバー上で別扱いになる。
if (process.platform === 'win32') {
  app.setAppUserModelId('com.vibeeditor.app');
}

// シングルインスタンスロック: 二重起動を試みた側は即座に終わらせ、
// 既存プロセスの window を前面に戻す。トレイ常駐時に launcher から
// 再度クリックされてもちゃんと復帰できるようになる。
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });
}

// `app.quit()` が呼ばれたら isQuitting を立て、以後 close は hide に
// 化けないようにする。app:restart / auto-updater / トレイ終了ルートを一括で救う。
app.on('before-quit', () => {
  isQuitting = true;
});

app.whenReady().then(async () => {
  try {
    await teamHub.start();
  } catch (err) {
    console.error('[TeamHub] failed to start:', err);
  }

  createWindow();
  setupTray();
  initAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showMainWindow();
  });
});

app.on('will-quit', () => {
  teamHub.stop();
  if (tray) {
    try {
      tray.destroy();
    } catch {
      /* noop */
    }
    tray = null;
  }
});

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, navigationUrl) => {
    const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
    if (rendererUrl && navigationUrl.startsWith(rendererUrl)) return;
    event.preventDefault();
  });
});

// トレイ常駐方針のため、全ウィンドウが閉じても quit しない。
// 実際の終了はトレイメニューの「終了」 or before-quit 経由の app.quit()。
app.on('window-all-closed', () => {
  /* intentionally empty: keep running in the tray */
});

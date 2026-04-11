import { app, BrowserWindow, ipcMain } from 'electron';

export function registerAppIpc(): void {
  ipcMain.handle('app:getProjectRoot', () => {
    return process.cwd();
  });

  ipcMain.handle('app:restart', () => {
    app.relaunch();
    app.exit(0);
  });

  ipcMain.handle('app:setWindowTitle', (event, title: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.setTitle(title);
  });
}

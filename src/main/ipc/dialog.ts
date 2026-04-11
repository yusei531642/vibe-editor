import { BrowserWindow, dialog, ipcMain } from 'electron';
import { promises as fs } from 'fs';

/**
 * ファイル/フォルダ選択ダイアログを提供する。
 * すべてのハンドラは「キャンセル時は null を返す」契約。
 */
export function registerDialogIpc(): void {
  ipcMain.handle(
    'dialog:openFolder',
    async (event, title: string = 'フォルダを選択'): Promise<string | null> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return null;
      const result = await dialog.showOpenDialog(win, {
        title,
        properties: ['openDirectory', 'createDirectory', 'promptToCreate']
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0];
    }
  );

  ipcMain.handle(
    'dialog:openFile',
    async (event, title: string = 'ファイルを選択'): Promise<string | null> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return null;
      const result = await dialog.showOpenDialog(win, {
        title,
        properties: ['openFile'],
        filters: [
          { name: 'All Files', extensions: ['*'] },
          { name: 'Markdown', extensions: ['md', 'markdown'] },
          { name: 'TypeScript/JavaScript', extensions: ['ts', 'tsx', 'js', 'jsx', 'mjs'] },
          { name: 'JSON', extensions: ['json'] }
        ]
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0];
    }
  );

  /** 指定フォルダが空かどうかを返す（新規プロジェクト判定用） */
  ipcMain.handle('dialog:isFolderEmpty', async (_e, folderPath: string): Promise<boolean> => {
    try {
      const entries = await fs.readdir(folderPath);
      return entries.length === 0;
    } catch {
      return false;
    }
  });
}

import { BrowserWindow, WebContents } from 'electron';

/**
 * webContents.id から対応する WebContents を引く。
 * 対象ウィンドウが既に閉じられている場合や destroy 済みの場合は undefined。
 */
export function findWebContentsById(id: number): WebContents | undefined {
  const wc = BrowserWindow.getAllWindows().find((w) => w.webContents.id === id)?.webContents;
  if (!wc || wc.isDestroyed()) return undefined;
  return wc;
}

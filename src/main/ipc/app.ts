import { app, BrowserWindow, ipcMain } from 'electron';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { promisify } from 'util';
import type { ClaudeCheckResult } from '../../types/shared';

const execFileAsync = promisify(execFile);

/**
 * 指定コマンド（例: `claude`）が PATH 上に存在するか確認する。
 * - 絶対パス / 相対パス（区切り文字を含む）が渡された場合は fs.access で検証
 * - それ以外は `where` (Windows) / `which` (Unix) でパス解決
 */
async function checkClaudeAvailable(command: string): Promise<ClaudeCheckResult> {
  const cmd = command.trim() || 'claude';

  // パス区切りを含む → ファイル直接チェック
  if (/[\\/]/.test(cmd)) {
    try {
      await fs.access(cmd);
      return { ok: true, path: cmd };
    } catch {
      return { ok: false, error: `ファイルが見つかりません: ${cmd}` };
    }
  }

  // PATH 上で探す
  const resolver = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileAsync(resolver, [cmd], { windowsHide: true });
    const first = stdout.trim().split(/\r?\n/)[0];
    if (!first) {
      return { ok: false, error: `${cmd} コマンドが見つかりません` };
    }
    return { ok: true, path: first };
  } catch (err) {
    const msg = (err as Error).message || String(err);
    return {
      ok: false,
      error: /not found|cannot find|は、内部コマンドまたは/.test(msg)
        ? `${cmd} コマンドが PATH 上にありません`
        : msg
    };
  }
}

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

  ipcMain.handle(
    'app:checkClaude',
    async (_e, command: string): Promise<ClaudeCheckResult> => {
      return checkClaudeAvailable(command);
    }
  );
}

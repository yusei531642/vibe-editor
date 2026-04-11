import { ipcMain } from 'electron';
import { promises as fs } from 'fs';
import { join } from 'path';
import type { ClaudeMdFile, SaveResult } from '../../types/shared';

/**
 * プロジェクトルート直下のCLAUDE.mdを検出して読み込む。
 * 存在しない場合は exists=false で想定パスだけ返す（新規作成用）。
 */
async function findAndReadClaudeMd(projectRoot: string): Promise<ClaudeMdFile> {
  const target = join(projectRoot, 'CLAUDE.md');
  try {
    const content = await fs.readFile(target, 'utf-8');
    return { path: target, content, exists: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { path: target, content: null, exists: false };
    }
    throw err;
  }
}

async function saveClaudeMd(filePath: string, content: string): Promise<SaveResult> {
  try {
    await fs.writeFile(filePath, content, 'utf-8');
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, path: filePath, error: (err as Error).message };
  }
}

export function registerClaudeMdIpc(): void {
  ipcMain.handle('claude-md:find', async (_e, projectRoot: string) => {
    return findAndReadClaudeMd(projectRoot);
  });

  ipcMain.handle(
    'claude-md:save',
    async (_e, filePath: string, content: string): Promise<SaveResult> => {
      return saveClaudeMd(filePath, content);
    }
  );
}

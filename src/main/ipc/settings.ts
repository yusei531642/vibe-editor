import { app, ipcMain } from 'electron';
import { promises as fs } from 'fs';
import { join } from 'path';
import { DEFAULT_SETTINGS, type AppSettings } from '../../types/shared';

const SETTINGS_FILENAME = 'settings.json';

function settingsPath(): string {
  return join(app.getPath('userData'), SETTINGS_FILENAME);
}

async function loadSettings(): Promise<AppSettings> {
  const filePath = settingsPath();
  try {
    const text = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(text) as Partial<AppSettings>;
    // 欠損キーはデフォルトで埋める（前方互換）
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...DEFAULT_SETTINGS };
    }
    // 壊れていた場合はデフォルトを返す（データは残す）
    console.error('[settings] 読み込み失敗:', err);
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(settings: AppSettings): Promise<void> {
  const filePath = settingsPath();
  await fs.mkdir(join(filePath, '..'), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(settings, null, 2), 'utf-8');
}

export function registerSettingsIpc(): void {
  ipcMain.handle('settings:load', async (): Promise<AppSettings> => {
    return loadSettings();
  });
  ipcMain.handle('settings:save', async (_e, settings: AppSettings): Promise<void> => {
    await saveSettings(settings);
  });
}

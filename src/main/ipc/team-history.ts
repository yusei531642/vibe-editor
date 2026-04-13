import { ipcMain } from 'electron';
import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { TeamHistoryEntry } from '../../types/shared';

/**
 * チーム履歴の永続化。
 *
 * `~/.vibe-editor/team-history.json` に全プロジェクトのエントリを一つの配列で保存し、
 * 取得時に projectRoot でフィルタする。20 件でトリム（古い lastUsedAt から）。
 */

const HISTORY_DIR = join(homedir(), '.vibe-editor');
const HISTORY_FILE = join(HISTORY_DIR, 'team-history.json');
const MAX_ENTRIES = 20;

async function readAll(): Promise<TeamHistoryEntry[]> {
  try {
    const raw = await fs.readFile(HISTORY_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as TeamHistoryEntry[];
  } catch {
    return [];
  }
}

async function writeAll(entries: TeamHistoryEntry[]): Promise<void> {
  await fs.mkdir(HISTORY_DIR, { recursive: true });
  await fs.writeFile(HISTORY_FILE, JSON.stringify(entries, null, 2), 'utf-8');
}

/** プロジェクト単位でトリム。lastUsedAt 降順で上位 MAX_ENTRIES 件を残す */
function trimByProject(entries: TeamHistoryEntry[]): TeamHistoryEntry[] {
  const byProject = new Map<string, TeamHistoryEntry[]>();
  for (const e of entries) {
    const arr = byProject.get(e.projectRoot) ?? [];
    arr.push(e);
    byProject.set(e.projectRoot, arr);
  }
  const result: TeamHistoryEntry[] = [];
  for (const arr of byProject.values()) {
    arr.sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? ''));
    result.push(...arr.slice(0, MAX_ENTRIES));
  }
  return result;
}

export function registerTeamHistoryIpc(): void {
  ipcMain.handle(
    'teamHistory:list',
    async (_e, projectRoot: string): Promise<TeamHistoryEntry[]> => {
      const all = await readAll();
      return all
        .filter((e) => e.projectRoot === projectRoot)
        .sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? ''));
    }
  );

  ipcMain.handle(
    'teamHistory:save',
    async (_e, entry: TeamHistoryEntry): Promise<{ ok: boolean; error?: string }> => {
      try {
        const all = await readAll();
        const idx = all.findIndex((e) => e.id === entry.id);
        if (idx >= 0) all[idx] = entry;
        else all.push(entry);
        await writeAll(trimByProject(all));
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }
  );

  ipcMain.handle(
    'teamHistory:delete',
    async (_e, id: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        const all = await readAll();
        const next = all.filter((e) => e.id !== id);
        await writeAll(next);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }
  );
}

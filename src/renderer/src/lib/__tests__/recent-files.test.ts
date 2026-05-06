import { describe, it, expect } from 'vitest';
import type { RecentFileEntry } from '../hooks/use-file-tabs';
import { RECENT_FILES_LIMIT } from '../hooks/use-file-tabs';

/**
 * Issue #480: 最近開いたファイル履歴のロジックをテスト。
 * useFileTabs 内の setRecentFiles ロジックを純粋関数として再現し、
 * 順序・重複排除・上限を検証する。
 */

/** openEditorTab 時の recentFiles 更新ロジックを再現 */
function addRecentFile(
  prev: RecentFileEntry[],
  rootPath: string,
  relPath: string
): RecentFileEntry[] {
  const filtered = prev.filter(
    (entry) => !(entry.rootPath === rootPath && entry.relPath === relPath)
  );
  return [{ rootPath, relPath }, ...filtered].slice(0, RECENT_FILES_LIMIT);
}

describe('recentFiles', () => {
  it('adds a new file to the front of the list', () => {
    const result = addRecentFile([], '/root', 'src/app.ts');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ rootPath: '/root', relPath: 'src/app.ts' });
  });

  it('moves an already-existing file to the front', () => {
    const initial: RecentFileEntry[] = [
      { rootPath: '/root', relPath: 'a.ts' },
      { rootPath: '/root', relPath: 'b.ts' },
      { rootPath: '/root', relPath: 'c.ts' }
    ];
    const result = addRecentFile(initial, '/root', 'c.ts');
    expect(result).toHaveLength(3);
    expect(result[0].relPath).toBe('c.ts');
    expect(result[1].relPath).toBe('a.ts');
    expect(result[2].relPath).toBe('b.ts');
  });

  it('does not create duplicates', () => {
    const initial: RecentFileEntry[] = [
      { rootPath: '/root', relPath: 'a.ts' }
    ];
    const result = addRecentFile(initial, '/root', 'a.ts');
    expect(result).toHaveLength(1);
    expect(result[0].relPath).toBe('a.ts');
  });

  it('treats same relPath with different rootPath as separate entries', () => {
    const initial: RecentFileEntry[] = [
      { rootPath: '/root1', relPath: 'src/app.ts' }
    ];
    const result = addRecentFile(initial, '/root2', 'src/app.ts');
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ rootPath: '/root2', relPath: 'src/app.ts' });
    expect(result[1]).toEqual({ rootPath: '/root1', relPath: 'src/app.ts' });
  });

  it('enforces the RECENT_FILES_LIMIT', () => {
    let list: RecentFileEntry[] = [];
    // 上限を超える数のファイルを追加
    for (let i = 0; i < RECENT_FILES_LIMIT + 5; i++) {
      list = addRecentFile(list, '/root', `file-${i}.ts`);
    }
    expect(list).toHaveLength(RECENT_FILES_LIMIT);
    // 最新のファイルが先頭にある
    expect(list[0].relPath).toBe(`file-${RECENT_FILES_LIMIT + 4}.ts`);
    // 最古のファイルは削除されている
    expect(list.find((e) => e.relPath === 'file-0.ts')).toBeUndefined();
  });

  it('preserves order of untouched entries', () => {
    const initial: RecentFileEntry[] = [
      { rootPath: '/root', relPath: 'a.ts' },
      { rootPath: '/root', relPath: 'b.ts' },
      { rootPath: '/root', relPath: 'c.ts' }
    ];
    const result = addRecentFile(initial, '/root', 'new.ts');
    expect(result.map((e) => e.relPath)).toEqual(['new.ts', 'a.ts', 'b.ts', 'c.ts']);
  });

  it('RECENT_FILES_LIMIT is between 10 and 20', () => {
    expect(RECENT_FILES_LIMIT).toBeGreaterThanOrEqual(10);
    expect(RECENT_FILES_LIMIT).toBeLessThanOrEqual(20);
  });
});

import { app, ipcMain } from 'electron';
import { promises as fs } from 'fs';
import { join } from 'path';
import type { SkillInfo } from '../../types/shared';

/**
 * 非常に単純化したYAML frontmatterパーサー。
 * `---` で囲まれたブロックから `name:` と `description:` だけを抽出する。
 * description は複数行（折り畳みスカラー `>` や `|`、または素の継続）に対応。
 */
function parseFrontmatter(text: string): { name?: string; description?: string } {
  const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const block = match[1];
  const lines = block.split(/\r?\n/);

  const result: { name?: string; description?: string } = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) {
      i++;
      continue;
    }
    const key = kv[1];
    const rawValue = kv[2];

    if (key === 'name') {
      result.name = rawValue.trim().replace(/^["']|["']$/g, '');
      i++;
      continue;
    }

    if (key === 'description') {
      // 折り畳みスカラー `>` / `|`、または空 → 次行以降インデント行を連結
      if (rawValue.trim() === '' || rawValue.trim() === '>' || rawValue.trim() === '|') {
        const collected: string[] = [];
        i++;
        while (i < lines.length) {
          const next = lines[i];
          if (/^\s+/.test(next) || next.trim() === '') {
            collected.push(next.trim());
            i++;
          } else {
            break;
          }
        }
        result.description = collected.filter(Boolean).join(' ').trim();
      } else {
        result.description = rawValue.trim().replace(/^["']|["']$/g, '');
        i++;
      }
      continue;
    }

    i++;
  }
  return result;
}

async function scanSkillDir(
  root: string,
  source: SkillInfo['source']
): Promise<SkillInfo[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw err;
  }

  const results: SkillInfo[] = [];
  for (const entry of entries) {
    const skillDir = join(root, entry);
    try {
      const stat = await fs.stat(skillDir);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    const skillMdPath = join(skillDir, 'SKILL.md');
    try {
      const text = await fs.readFile(skillMdPath, 'utf-8');
      const fm = parseFrontmatter(text);
      results.push({
        name: fm.name ?? entry,
        description: (fm.description ?? '').replace(/\s+/g, ' ').trim(),
        path: skillMdPath,
        source
      });
    } catch {
      // SKILL.md が読めないディレクトリはスキップ
    }
  }
  return results;
}

async function listSkills(projectRoot: string): Promise<SkillInfo[]> {
  const userSkills = join(app.getPath('home'), '.claude', 'skills');
  const projectSkills = join(projectRoot, '.claude', 'skills');

  const [u, p] = await Promise.all([
    scanSkillDir(userSkills, 'user'),
    scanSkillDir(projectSkills, 'project')
  ]);

  // 同名はプロジェクト優先、その後ユーザー
  const map = new Map<string, SkillInfo>();
  for (const s of u) map.set(s.name, s);
  for (const s of p) map.set(s.name, s);

  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function registerSkillsIpc(): void {
  ipcMain.handle('skills:list', async (_e, projectRoot: string) => {
    return listSkills(projectRoot);
  });
}

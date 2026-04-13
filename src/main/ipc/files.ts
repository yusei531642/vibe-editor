import { ipcMain } from 'electron';
import { promises as fs } from 'fs';
import { join, normalize, resolve, sep, basename, dirname } from 'path';
import { randomBytes } from 'crypto';
import type {
  FileListResult,
  FileNode,
  FileReadResult,
  FileWriteResult
} from '../../types/shared';

/**
 * ファイルツリー用の固定除外リスト。
 * .gitignore を尊重する実装はコストが高いので、まずは典型的な邪魔ディレクトリを
 * ハードコードで除外する。設定化は後日。
 */
const EXCLUDE_DIRS = new Set([
  '.git',
  'node_modules',
  'out',
  'dist',
  'release',
  '.vite',
  '.next',
  '.cache',
  '.parcel-cache',
  '.turbo',
  '.DS_Store'
]);

/** projectRoot 配下かを検査し、正規化した絶対パスを返す。範囲外なら null */
function safeResolve(projectRoot: string, relPath: string): string | null {
  const root = normalize(resolve(projectRoot));
  const abs = normalize(resolve(root, relPath));
  if (abs !== root && !abs.startsWith(root + sep) && !abs.startsWith(root + '/')) {
    return null;
  }
  return abs;
}

function toRelPosix(root: string, abs: string): string {
  const rel = abs.slice(root.length).replace(/^[\\/]+/, '');
  return rel.split(sep).join('/');
}

async function listDir(projectRoot: string, relPath: string): Promise<FileListResult> {
  try {
    const root = normalize(resolve(projectRoot));
    const abs = safeResolve(projectRoot, relPath);
    if (!abs) {
      return { ok: false, error: 'パスがプロジェクト範囲外です', dir: relPath, entries: [] };
    }
    const stat = await fs.stat(abs);
    if (!stat.isDirectory()) {
      return { ok: false, error: 'ディレクトリではありません', dir: relPath, entries: [] };
    }
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const nodes: FileNode[] = [];
    for (const ent of entries) {
      if (EXCLUDE_DIRS.has(ent.name)) continue;
      if (ent.name.startsWith('.') && EXCLUDE_DIRS.has(ent.name)) continue;
      const childAbs = join(abs, ent.name);
      nodes.push({
        name: ent.name,
        path: toRelPosix(root, childAbs),
        isDir: ent.isDirectory()
      });
    }
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    return { ok: true, dir: toRelPosix(root, abs), entries: nodes };
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message,
      dir: relPath,
      entries: []
    };
  }
}

/** NULL バイトの存在でバイナリ判定。最初の8KBだけ見る */
function looksBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

async function readFile(projectRoot: string, relPath: string): Promise<FileReadResult> {
  try {
    const abs = safeResolve(projectRoot, relPath);
    if (!abs) {
      return {
        ok: false,
        error: 'パスがプロジェクト範囲外です',
        path: relPath,
        content: '',
        isBinary: false,
        encoding: 'utf-8'
      };
    }
    const buf = await fs.readFile(abs);
    if (looksBinary(buf)) {
      return {
        ok: true,
        path: relPath,
        content: '',
        isBinary: true,
        encoding: 'binary'
      };
    }
    return {
      ok: true,
      path: relPath,
      content: buf.toString('utf-8'),
      isBinary: false,
      encoding: 'utf-8'
    };
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message,
      path: relPath,
      content: '',
      isBinary: false,
      encoding: 'utf-8'
    };
  }
}

async function writeFile(
  projectRoot: string,
  relPath: string,
  content: string
): Promise<FileWriteResult> {
  try {
    const abs = safeResolve(projectRoot, relPath);
    if (!abs) {
      return { ok: false, error: 'パスがプロジェクト範囲外です' };
    }
    const dir = dirname(abs);
    const tmpName = `.${basename(abs)}.${randomBytes(6).toString('hex')}.tmp`;
    const tmpPath = join(dir, tmpName);
    await fs.writeFile(tmpPath, content, 'utf-8');
    try {
      await fs.rename(tmpPath, abs);
    } catch (err) {
      // rename 失敗時は tmp を掃除してから再スロー
      try {
        await fs.unlink(tmpPath);
      } catch {
        /* noop */
      }
      throw err;
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function registerFilesIpc(): void {
  ipcMain.handle(
    'files:list',
    async (_e, projectRoot: string, relPath: string): Promise<FileListResult> => {
      return listDir(projectRoot, relPath ?? '');
    }
  );

  ipcMain.handle(
    'files:read',
    async (_e, projectRoot: string, relPath: string): Promise<FileReadResult> => {
      return readFile(projectRoot, relPath);
    }
  );

  ipcMain.handle(
    'files:write',
    async (
      _e,
      projectRoot: string,
      relPath: string,
      content: string
    ): Promise<FileWriteResult> => {
      return writeFile(projectRoot, relPath, content);
    }
  );
}

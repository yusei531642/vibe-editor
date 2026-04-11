import { ipcMain } from 'electron';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import type { GitDiffResult, GitFileChange, GitStatus } from '../../types/shared';

const execFileAsync = promisify(execFile);

/** git コマンドを指定 cwd で実行。最大バッファを広げてある（大きな diff 対策）。 */
async function runGit(
  cwd: string,
  args: string[],
  options: { encoding?: BufferEncoding } = {}
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    encoding: options.encoding ?? 'utf8',
    windowsHide: true
  });
  return { stdout: stdout.toString(), stderr: stderr.toString() };
}

/** `git status --porcelain=v1 -z` 出力をパース */
function parsePorcelain(raw: string): GitFileChange[] {
  if (raw.length === 0) return [];
  // -z 付きだと NUL 区切り。rename の場合は `R  new<NUL>old<NUL>` の2要素構成
  const records = raw.split('\0').filter((s) => s.length > 0);
  const files: GitFileChange[] = [];
  let i = 0;
  while (i < records.length) {
    const record = records[i];
    if (record.length < 3) {
      i++;
      continue;
    }
    const indexStatus = record[0];
    const worktreeStatus = record[1];
    let path = record.slice(3); // 「XY 」の後
    // Rename は次レコードに旧名が入る → 現在ファイル名は "new" 側
    const isRename = indexStatus === 'R' || worktreeStatus === 'R';
    if (isRename && i + 1 < records.length) {
      i += 2;
    } else {
      i++;
    }
    files.push({
      path,
      indexStatus,
      worktreeStatus,
      label: statusLabel(indexStatus, worktreeStatus)
    });
  }
  return files;
}

function statusLabel(index: string, worktree: string): string {
  if (index === '?' && worktree === '?') return 'Untracked';
  if (index === '!' && worktree === '!') return 'Ignored';
  if (index === 'A' || worktree === 'A') return 'Added';
  if (index === 'D' || worktree === 'D') return 'Deleted';
  if (index === 'R' || worktree === 'R') return 'Renamed';
  if (index === 'C' || worktree === 'C') return 'Copied';
  if (index === 'U' || worktree === 'U') return 'Conflict';
  if (index === 'M' || worktree === 'M') return 'Modified';
  return `${index}${worktree}`.trim() || 'Changed';
}

async function getGitStatus(projectRoot: string): Promise<GitStatus> {
  try {
    const rootResult = await runGit(projectRoot, ['rev-parse', '--show-toplevel']);
    const repoRoot = rootResult.stdout.trim();

    let branch = '';
    try {
      const b = await runGit(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
      branch = b.stdout.trim();
    } catch {
      branch = '';
    }

    const status = await runGit(repoRoot, ['status', '--porcelain=v1', '-z']);
    const files = parsePorcelain(status.stdout);
    return { ok: true, repoRoot, branch, files };
  } catch (err) {
    const message = (err as Error).message || String(err);
    // git自体が無い場合と、リポジトリでない場合の両方に対応
    if (/not a git repository/i.test(message)) {
      return { ok: false, error: 'Gitリポジトリではありません', files: [] };
    }
    if (/ENOENT/.test(message) || /is not recognized/i.test(message)) {
      return { ok: false, error: 'git コマンドが見つかりません（PATH を確認してください）', files: [] };
    }
    return { ok: false, error: message, files: [] };
  }
}

/** 単一ファイルについて HEAD と作業ツリーの内容を取得する */
async function getFileDiff(projectRoot: string, relPath: string): Promise<GitDiffResult> {
  try {
    const rootResult = await runGit(projectRoot, ['rev-parse', '--show-toplevel']);
    const repoRoot = rootResult.stdout.trim();

    // バイナリ検査: git diff --numstat が "-\t-" を出す
    let isBinary = false;
    try {
      const { stdout } = await runGit(repoRoot, [
        'diff',
        '--numstat',
        '--',
        relPath
      ]);
      const line = stdout.trim().split(/\r?\n/)[0] ?? '';
      if (line.startsWith('-\t-')) isBinary = true;
    } catch {
      // 無視
    }

    if (isBinary) {
      return {
        ok: true,
        path: relPath,
        isNew: false,
        isDeleted: false,
        isBinary: true,
        original: '',
        modified: ''
      };
    }

    // HEAD 側の内容
    let original = '';
    let isNew = false;
    try {
      const { stdout } = await runGit(repoRoot, ['show', `HEAD:${relPath}`]);
      original = stdout;
    } catch (err) {
      const msg = (err as Error).message || '';
      if (/exists on disk, but not in|does not exist|unknown revision|path.*does not exist/i.test(msg)) {
        isNew = true;
        original = '';
      } else if (/ambiguous argument.*HEAD/i.test(msg)) {
        // 初回コミット前
        isNew = true;
        original = '';
      } else {
        throw err;
      }
    }

    // 作業ツリー側の内容
    let modified = '';
    let isDeleted = false;
    const absPath = join(repoRoot, relPath);
    try {
      modified = await fs.readFile(absPath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        isDeleted = true;
        modified = '';
      } else {
        throw err;
      }
    }

    return {
      ok: true,
      path: relPath,
      isNew,
      isDeleted,
      isBinary: false,
      original,
      modified
    };
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message || String(err),
      path: relPath,
      isNew: false,
      isDeleted: false,
      isBinary: false,
      original: '',
      modified: ''
    };
  }
}

export function registerGitIpc(): void {
  ipcMain.handle('git:status', async (_e, projectRoot: string) => {
    return getGitStatus(projectRoot);
  });
  ipcMain.handle('git:diff', async (_e, projectRoot: string, relPath: string) => {
    return getFileDiff(projectRoot, relPath);
  });
}

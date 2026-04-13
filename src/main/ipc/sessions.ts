import { app, ipcMain } from 'electron';
import { promises as fs } from 'fs';
import { join, basename } from 'path';
import type { SessionInfo } from '../../types/shared';

/**
 * プロジェクト絶対パスを Claude Code のプロジェクト識別ディレクトリ名に変換する。
 * 例: `D:\my-project` → `D--my-project`
 * Claude Code は非英数を `-` に置換するルール（観測ベース）。
 */
export function encodeProjectPath(absPath: string): string {
  return absPath.replace(/[^a-zA-Z0-9-]/g, '-');
}

/** Claude Code のプロジェクト別セッションディレクトリの絶対パス */
export function getClaudeSessionsDir(projectRoot: string): string {
  return join(app.getPath('home'), '.claude', 'projects', encodeProjectPath(projectRoot));
}

/** ディレクトリ内の session jsonl ファイル名集合（拡張子なし）を返す */
export async function listClaudeSessionIds(projectRoot: string): Promise<Set<string>> {
  const dir = getClaudeSessionsDir(projectRoot);
  try {
    const entries = await fs.readdir(dir);
    const out = new Set<string>();
    for (const e of entries) {
      if (e.endsWith('.jsonl')) out.add(basename(e, '.jsonl'));
    }
    return out;
  } catch {
    return new Set();
  }
}

/**
 * JSONL 1行から、表示可能なユーザーメッセージテキストを抽出。
 * Claude Code の JSONL は複数フォーマットがありうるため緩く探索する。
 */
function extractUserText(obj: unknown): string {
  if (!obj || typeof obj !== 'object') return '';
  const o = obj as Record<string, unknown>;

  // 形式1: {type:'user', message:{content:[{type:'text',text:'...'}]}}
  if (o.type === 'user' && o.message && typeof o.message === 'object') {
    const msg = o.message as Record<string, unknown>;
    const content = msg.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === 'string') return part;
        if (
          part &&
          typeof part === 'object' &&
          typeof (part as Record<string, unknown>).text === 'string'
        ) {
          return (part as Record<string, unknown>).text as string;
        }
      }
    }
  }
  // 形式2: {role:'user', content:'...'}
  if (o.role === 'user' && typeof o.content === 'string') return o.content;
  // 形式3: 直接 text プロパティ
  if (o.type === 'user' && typeof o.text === 'string') return o.text;
  return '';
}

function sanitizeTitle(text: string): string {
  // 先頭の空白・改行を削ぎ、1行化、長すぎる場合は省略
  const singleLine = text.replace(/\s+/g, ' ').trim();
  if (singleLine.length === 0) return '(空のセッション)';
  if (singleLine.length > 80) return singleLine.slice(0, 79) + '…';
  return singleLine;
}

async function parseSessionFile(filePath: string): Promise<SessionInfo | null> {
  try {
    const stat = await fs.stat(filePath);
    const text = await fs.readFile(filePath, 'utf-8');
    const lines = text.split(/\r?\n/).filter((l) => l.length > 0);

    let firstUserText = '';
    let messageCount = 0;

    for (const line of lines) {
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (!obj || typeof obj !== 'object') continue;
      const t = (obj as Record<string, unknown>).type;
      if (t === 'user' || t === 'assistant') messageCount++;
      if (!firstUserText && t === 'user') {
        firstUserText = extractUserText(obj);
      }
    }

    return {
      id: basename(filePath, '.jsonl'),
      path: filePath,
      title: sanitizeTitle(firstUserText),
      messageCount,
      lastModifiedAt: stat.mtime.toISOString()
    };
  } catch {
    return null;
  }
}

async function listSessions(projectRoot: string): Promise<SessionInfo[]> {
  const encoded = encodeProjectPath(projectRoot);
  const dir = join(app.getPath('home'), '.claude', 'projects', encoded);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const jsonlFiles = entries.filter((e) => e.endsWith('.jsonl'));
  const sessions: SessionInfo[] = [];
  for (const file of jsonlFiles) {
    const info = await parseSessionFile(join(dir, file));
    if (info) sessions.push(info);
  }
  // 新しい順
  sessions.sort((a, b) => b.lastModifiedAt.localeCompare(a.lastModifiedAt));
  return sessions;
}

export function registerSessionsIpc(): void {
  ipcMain.handle('sessions:list', async (_e, projectRoot: string) => {
    return listSessions(projectRoot);
  });
}

import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const PASTE_DIR_NAME = 'vibe-editor-pastes';
const TTL_MS = 24 * 60 * 60 * 1000;

function mimeToExt(mimeType: string): string {
  switch (mimeType) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'image/bmp':
      return 'bmp';
    default:
      return 'png';
  }
}

async function cleanupOldPastes(dir: string): Promise<void> {
  try {
    const now = Date.now();
    const entries = await fs.readdir(dir);
    await Promise.all(
      entries.map(async (name) => {
        try {
          const p = join(dir, name);
          const s = await fs.stat(p);
          if (now - s.mtimeMs > TTL_MS) await fs.unlink(p);
        } catch {
          /* noop */
        }
      })
    );
  } catch {
    /* noop */
  }
}

/**
 * base64 画像を TTL 付きの一時ファイルとして書き出し、絶対パスを返す。
 * 24 時間以上経過した過去のペーストは呼び出しごとにまとめて掃除する。
 */
export async function savePastedImage(
  base64: string,
  mimeType: string
): Promise<{ ok: boolean; path?: string; error?: string }> {
  try {
    const ext = mimeToExt(mimeType);
    const dir = join(tmpdir(), PASTE_DIR_NAME);
    await fs.mkdir(dir, { recursive: true });
    await cleanupOldPastes(dir);

    const d = new Date();
    const pad = (n: number): string => n.toString().padStart(2, '0');
    const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const rand = Math.random().toString(36).slice(2, 6);
    const filename = `paste-${ts}-${rand}.${ext}`;
    const filePath = join(dir, filename);

    const buffer = Buffer.from(base64, 'base64');
    await fs.writeFile(filePath, buffer);
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

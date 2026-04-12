import { app, BrowserWindow, ipcMain } from 'electron';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { IPty } from 'node-pty';
import type {
  TerminalCreateOptions,
  TerminalCreateResult,
  TerminalExitInfo
} from '../../types/shared';

// node-pty は external にしているため動的require。
// main プロセスは CommonJS にバンドルされるので require で解決される。
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodePty: typeof import('node-pty') = require('node-pty');

interface Session {
  pty: IPty;
  webContentsId: number;
}

const sessions = new Map<string, Session>();

/**
 * Windows では PATH 経由の .cmd ラッパー（例: C:\...\npm\claude.cmd）を
 * そのまま spawn するとConPTY 側でうまく引数解釈されない場合があるため、
 * cmd.exe /c <command> にフォールバックするユーティリティ。
 */
function resolveCommand(
  command: string | undefined,
  args: string[] | undefined
): { command: string; args: string[] } {
  if (!command) {
    // 既定シェル
    if (process.platform === 'win32') {
      return { command: 'powershell.exe', args: ['-NoLogo'] };
    }
    return { command: process.env.SHELL || '/bin/bash', args: [] };
  }

  if (process.platform === 'win32') {
    // .cmd/.bat は cmd.exe 経由で起動する（ConPTYで安定）
    const lower = command.toLowerCase();
    if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
      return {
        command: process.env.COMSPEC || 'cmd.exe',
        args: ['/c', command, ...(args ?? [])]
      };
    }
    // 拡張子無し & 素の実行ファイル名（"claude" 等）は PATH から .cmd を探して cmd.exe 経由で起動
    if (!/[\\/]/.test(command) && !/\.[a-z]{2,4}$/i.test(command)) {
      return {
        command: process.env.COMSPEC || 'cmd.exe',
        args: ['/c', command, ...(args ?? [])]
      };
    }
  }

  return { command, args: args ?? [] };
}

export function registerTerminalIpc(): void {
  ipcMain.handle(
    'terminal:create',
    (event, opts: TerminalCreateOptions): TerminalCreateResult => {
      try {
        const { command, args } = resolveCommand(opts.command, opts.args);

        const pty = nodePty.spawn(command, args, {
          name: 'xterm-256color',
          cols: Math.max(20, opts.cols || 80),
          rows: Math.max(5, opts.rows || 24),
          cwd: opts.cwd,
          env: {
            ...(process.env as Record<string, string>),
            ...(opts.env ?? {}),
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor'
          },
          // ConPTYを使う（Windows 10+）。false にすると winpty 互換
          useConpty: process.platform === 'win32' ? true : undefined
        });

        const id = randomUUID();
        const webContentsId = event.sender.id;
        sessions.set(id, { pty, webContentsId });

        pty.onData((data) => {
          const wc = BrowserWindow.fromId(
            BrowserWindow.getAllWindows().find((w) => w.webContents.id === webContentsId)?.id ??
              -1
          )?.webContents;
          if (wc && !wc.isDestroyed()) {
            wc.send(`terminal:data:${id}`, data);
          }
        });

        pty.onExit(({ exitCode, signal }) => {
          const wc = BrowserWindow.getAllWindows().find(
            (w) => w.webContents.id === webContentsId
          )?.webContents;
          if (wc && !wc.isDestroyed()) {
            const info: TerminalExitInfo = { exitCode, signal };
            wc.send(`terminal:exit:${id}`, info);
          }
          sessions.delete(id);
        });

        return {
          ok: true,
          id,
          command: [command, ...args].join(' ')
        };
      } catch (err) {
        return {
          ok: false,
          error: (err as Error).message || String(err)
        };
      }
    }
  );

  ipcMain.handle('terminal:write', (_e, id: string, data: string) => {
    sessions.get(id)?.pty.write(data);
  });

  ipcMain.handle('terminal:resize', (_e, id: string, cols: number, rows: number) => {
    try {
      sessions.get(id)?.pty.resize(Math.max(20, cols), Math.max(5, rows));
    } catch {
      // リサイズは無害なので例外は握りつぶす
    }
  });

  ipcMain.handle('terminal:kill', (_e, id: string) => {
    const s = sessions.get(id);
    if (s) {
      try {
        s.pty.kill();
      } catch {
        // 既に終了している場合がある
      }
      sessions.delete(id);
    }
  });

  // 画像ペースト用: base64 を一時ファイルとして書き出し、絶対パスを返す
  ipcMain.handle(
    'terminal:savePastedImage',
    async (
      _e,
      base64: string,
      mimeType: string
    ): Promise<{ ok: boolean; path?: string; error?: string }> => {
      try {
        const ext =
          mimeType === 'image/png'
            ? 'png'
            : mimeType === 'image/jpeg' || mimeType === 'image/jpg'
              ? 'jpg'
              : mimeType === 'image/gif'
                ? 'gif'
                : mimeType === 'image/webp'
                  ? 'webp'
                  : mimeType === 'image/bmp'
                    ? 'bmp'
                    : 'png';

        const dir = join(tmpdir(), 'vibe-editor-pastes');
        await fs.mkdir(dir, { recursive: true });

        // 24時間より古いファイルは自動掃除
        try {
          const now = Date.now();
          const TTL = 24 * 60 * 60 * 1000;
          const entries = await fs.readdir(dir);
          await Promise.all(
            entries.map(async (name) => {
              try {
                const p = join(dir, name);
                const s = await fs.stat(p);
                if (now - s.mtimeMs > TTL) await fs.unlink(p);
              } catch {
                /* noop */
              }
            })
          );
        } catch {
          /* noop */
        }

        // ファイル名: paste-YYYYMMDD-HHMMSS-<rand>.ext
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
  );

  // アプリ終了時に残存ptyを全て終了
  app.on('will-quit', () => {
    for (const s of sessions.values()) {
      try {
        s.pty.kill();
      } catch {
        /* noop */
      }
    }
    sessions.clear();
  });
}

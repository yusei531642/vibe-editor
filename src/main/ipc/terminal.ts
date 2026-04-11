import { app, BrowserWindow, ipcMain } from 'electron';
import { randomUUID } from 'crypto';
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
      return { command: process.env.COMSPEC || 'cmd.exe', args: [] };
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

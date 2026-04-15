import { app, ipcMain } from 'electron';
import { randomUUID } from 'crypto';
import { writeFileSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import type {
  TerminalCreateOptions,
  TerminalCreateResult,
  TerminalExitInfo
} from '../../types/shared';
import { cancelInjectTimers } from '../team-hub';
import { listClaudeSessionIds } from './sessions';
import { resolveCommand } from '../lib/resolve-command';
import { savePastedImage } from '../lib/paste-image-store';
import { findWebContentsById } from '../lib/webcontents';
import {
  sessions,
  agentSessions,
  registerSession,
  removeSession,
  killAllSessions,
  type Session
} from '../lib/session-registry';
import { watchClaudeSession } from '../lib/claude-session-watcher';
import { createBatchedDataSender } from '../lib/pty-data-batcher';

// node-pty は external にしているため動的require。
// main プロセスは CommonJS にバンドルされるので require で解決される。
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodePty: typeof import('node-pty') = require('node-pty');

/**
 * ConPTY は存在しない / ディレクトリでない cwd を渡されると
 * `CreateProcess` が Windows error 267 (ERROR_DIRECTORY) で失敗し、
 * 利用者に意味のないエラーを返してしまう。spawn 前に cwd を検証し、
 * 無効なら fallback → process.cwd() の順で救済する。戻り値の
 * `warning` は呼び出し元に「元の cwd は無効だった」旨を伝えるため。
 */
function resolveValidCwd(
  requested: string | undefined,
  fallback: string | undefined
): { cwd: string; warning: string | null } {
  const isValid = (p: string | undefined): p is string => {
    if (!p) return false;
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  if (isValid(requested)) return { cwd: requested, warning: null };
  if (isValid(fallback)) {
    return {
      cwd: fallback,
      warning: `指定された作業ディレクトリが無効です: ${requested || '(未設定)'} → ${fallback} で起動します`
    };
  }
  return {
    cwd: process.cwd(),
    warning: `作業ディレクトリが無効です: ${requested || '(未設定)'} → プロセス既定の ${process.cwd()} で起動します`
  };
}

export function registerTerminalIpc(): void {
  ipcMain.handle(
    'terminal:create',
    (event, opts: TerminalCreateOptions): TerminalCreateResult => {
      try {
        const { command, args } = resolveCommand(opts.command, opts.args);

        // Codex 用のチーム指示文が渡されていれば一時ファイルに書き出して
        // -c model_instructions_file=<path> を args に差し込む。
        // Claude の --append-system-prompt と同じ役割を果たす。
        if (opts.codexInstructions && /codex/i.test(command)) {
          try {
            const dir = join(app.getPath('userData'), 'codex-instructions');
            mkdirSync(dir, { recursive: true });
            const filePath = join(dir, `${randomUUID()}.md`);
            writeFileSync(filePath, opts.codexInstructions, 'utf-8');
            // TOML 文字列としてパスを渡す。バックスラッシュと二重引用符をエスケープ。
            const tomlStr = `"${filePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
            args.push('-c', `model_instructions_file=${tomlStr}`);
          } catch (err) {
            console.warn('[terminal] failed to write codex instructions file:', err);
          }
        }

        const resolvedCwd = resolveValidCwd(opts.cwd, opts.fallbackCwd);
        if (resolvedCwd.warning) {
          console.warn('[terminal]', resolvedCwd.warning);
        }

        const pty = nodePty.spawn(command, args, {
          name: 'xterm-256color',
          cols: Math.max(20, opts.cols || 80),
          rows: Math.max(5, opts.rows || 24),
          cwd: resolvedCwd.cwd,
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
        const session: Session = {
          pty,
          webContentsId,
          teamId: opts.teamId,
          agentId: opts.agentId,
          role: opts.role
        };
        registerSession(id, session);

        const batcher = createBatchedDataSender(webContentsId, `terminal:data:${id}`);
        pty.onData((data) => batcher.push(data));

        pty.onExit(({ exitCode, signal }) => {
          batcher.dispose();
          const wc = findWebContentsById(webContentsId);
          if (wc) {
            const info: TerminalExitInfo = { exitCode, signal };
            wc.send(`terminal:exit:${id}`, info);
          }
          const removed = removeSession(id);
          if (removed?.agentId) {
            cancelInjectTimers(removed.agentId);
          }
        });

        // Claude Code のセッション ID を検出するウォッチャー。
        // resume 用には `~/.claude/projects/<encoded>/*.jsonl` の**ファイル名**
        // （URL 形式ではなく UUID）が必要なので、spawn 前の snapshot と比較して
        // 新しく現れたエントリをこの pty の session id とする。
        // Claude Code 以外（codex 等）は jsonl を作らないのでウォッチしない。
        if (opts.agentId && resolvedCwd.cwd && /claude/i.test(command)) {
          watchClaudeSession({
            projectRoot: resolvedCwd.cwd,
            listClaudeSessionIds,
            isAlive: () => sessions.has(id),
            onSessionFound: (sessionId) => {
              // 注意: このコールバックは PTY 寿命外(ウォッチャー経由の非同期)で呼ばれ得る。
              // セッションが既に消えている / webContents が破棄されている可能性があるので
              // 二重に検証する。これがないと "dead target" への send で例外が出る。
              if (!sessions.has(id)) return;
              const wc = findWebContentsById(webContentsId);
              if (!wc || wc.isDestroyed()) return;
              try {
                wc.send(`terminal:sessionId:${id}`, sessionId);
              } catch (err) {
                console.warn('[terminal] sessionId dispatch failed:', err);
              }
            }
          }).catch((err) => {
            console.warn('[terminal] session watcher failed:', err);
          });
        }

        return {
          ok: true,
          id,
          command: [command, ...args].join(' '),
          warning: resolvedCwd.warning ?? undefined
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
      const removed = removeSession(id);
      if (removed?.agentId) {
        cancelInjectTimers(removed.agentId);
      }
    }
  });

  // 画像ペースト用: base64 を一時ファイルとして書き出し、絶対パスを返す
  ipcMain.handle(
    'terminal:savePastedImage',
    (_e, base64: string, mimeType: string) => savePastedImage(base64, mimeType)
  );

  // アプリ終了時に残存ptyを全て終了
  app.on('will-quit', () => {
    killAllSessions();
  });
}

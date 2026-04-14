import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { promisify } from 'util';
import type { ClaudeCheckResult } from '../../types/shared';

const execFileAsync = promisify(execFile);

/**
 * 指定コマンド（例: `claude`, `codex`）が PATH 上または絶対パスに存在するか確認する。
 * 絶対/相対パス (セパレータを含む場合) はそのままアクセス可能かを確認し、
 * それ以外は where/which で解決する。
 */
export async function checkCommandAvailable(command: string): Promise<ClaudeCheckResult> {
  const cmd = command.trim() || 'claude';

  if (/[\\/]/.test(cmd)) {
    try {
      await fs.access(cmd);
      return { ok: true, path: cmd };
    } catch {
      return { ok: false, error: `ファイルが見つかりません: ${cmd}` };
    }
  }

  const resolver = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileAsync(resolver, [cmd], { windowsHide: true, timeout: 5000 });
    const first = stdout.trim().split(/\r?\n/)[0];
    if (!first) {
      return { ok: false, error: `${cmd} コマンドが見つかりません` };
    }
    return { ok: true, path: first };
  } catch (err) {
    const msg = (err as Error).message || String(err);
    return {
      ok: false,
      error: /not found|cannot find|は、内部コマンドまたは/.test(msg)
        ? `${cmd} コマンドが PATH 上にありません`
        : msg
    };
  }
}

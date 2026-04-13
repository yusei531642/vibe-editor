import { app, BrowserWindow, ipcMain } from 'electron';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { promisify } from 'util';
import type { ClaudeCheckResult } from '../../types/shared';
import { teamHub } from '../team-hub';

const execFileAsync = promisify(execFile);

/**
 * 指定コマンド（例: `claude`）が PATH 上に存在するか確認する。
 */
async function checkClaudeAvailable(command: string): Promise<ClaudeCheckResult> {
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

export function registerAppIpc(): void {
  ipcMain.handle('app:getProjectRoot', () => {
    return process.cwd();
  });

  ipcMain.handle('app:restart', () => {
    app.relaunch();
    app.exit(0);
  });

  ipcMain.handle('app:setWindowTitle', (event, title: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.setTitle(title);
  });

  ipcMain.handle(
    'app:checkClaude',
    async (_e, command: string): Promise<ClaudeCheckResult> => {
      return checkClaudeAvailable(command);
    }
  );

  ipcMain.handle('app:setZoomLevel', (event, level: number) => {
    event.sender.setZoomLevel(level);
  });

  ipcMain.handle('app:getZoomLevel', (event) => {
    return event.sender.getZoomLevel();
  });

  // ---------- Team MCP (TeamHub bridge 方式) ----------
  //
  // Claude/Codex に MCP サーバー "vive-team" として TeamHub bridge を登録する。
  // bridge はメインプロセス内 TeamHub へ TCP 接続し、team_send は対象 pty に
  // 直接注入されるため、共有ファイルのポーリングは不要。

  interface BridgeDesired {
    type: 'stdio';
    command: string;
    args: string[];
    env: Record<string, string>;
  }

  function bridgeDesired(): BridgeDesired {
    return {
      // Claude Code の mcpServers エントリには type 必須（既存 codex エントリ参照）
      type: 'stdio',
      command: 'node',
      args: [teamHub.bridgePath.replace(/\\/g, '/')],
      env: {
        VIVE_TEAM_SOCKET: teamHub.socketAddress,
        VIVE_TEAM_TOKEN: teamHub.token
      }
    };
  }

  // ---- Claude Code: ~/.claude.json (ユーザースコープのみ) ----
  //
  // Claude Code の MCP 設定はユーザースコープ (top-level mcpServers) と
  // プロジェクトスコープ (projects[path].mcpServers) の2層があるが、後者は
  // キー正規化仕様がバージョン依存で不確実なため、確実に読まれる
  // ユーザースコープのみを使う。`claude mcp list` で接続確認済み。

  /** @returns true if config was actually changed */
  async function setupClaudeMcp(): Promise<boolean> {
    const claudeConfigPath = join(homedir(), '.claude.json');
    let config: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(claudeConfigPath, 'utf-8');
      config = JSON.parse(raw);
    } catch {
      /* noop */
    }

    if (!config.mcpServers || typeof config.mcpServers !== 'object') {
      config.mcpServers = {};
    }
    const servers = config.mcpServers as Record<string, unknown>;
    const desired = bridgeDesired();

    if (JSON.stringify(servers['vive-team']) === JSON.stringify(desired)) {
      return false;
    }

    servers['vive-team'] = desired;
    await fs.writeFile(claudeConfigPath, JSON.stringify(config, null, 2), 'utf-8');
    return true;
  }

  async function cleanupClaudeMcp(): Promise<void> {
    const claudeConfigPath = join(homedir(), '.claude.json');
    try {
      const raw = await fs.readFile(claudeConfigPath, 'utf-8');
      const config = JSON.parse(raw);
      if (config.mcpServers?.['vive-team']) {
        delete config.mcpServers['vive-team'];
        await fs.writeFile(claudeConfigPath, JSON.stringify(config, null, 2), 'utf-8');
      }
    } catch {
      /* noop */
    }
  }

  // ---- Codex: ~/.codex/config.toml ----

  const CODEX_SECTION = 'mcp_servers.vive-team';

  function removeTomlSection(content: string, section: string): string {
    const lines = content.split('\n');
    const result: string[] = [];
    let skip = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^\[.+\]$/.test(trimmed)) {
        const name = trimmed.slice(1, -1).trim();
        skip = name === section || name.startsWith(section + '.');
      }
      if (!skip) result.push(line);
    }
    while (result.length > 0 && result[result.length - 1].trim() === '') result.pop();
    return result.join('\n');
  }

  async function setupCodexMcp(): Promise<void> {
    const codexDir = join(homedir(), '.codex');
    const codexConfigPath = join(codexDir, 'config.toml');
    await fs.mkdir(codexDir, { recursive: true });

    let content = '';
    try {
      content = await fs.readFile(codexConfigPath, 'utf-8');
    } catch {
      /* noop */
    }

    content = removeTomlSection(content, CODEX_SECTION);

    const escaped = teamHub.bridgePath.replace(/\\/g, '/');
    const section = [
      '',
      `[${CODEX_SECTION}]`,
      `command = "node"`,
      `args = ["${escaped}"]`,
      `env_vars = ["VIVE_TEAM_ID", "VIVE_TEAM_ROLE", "VIVE_AGENT_ID", "VIVE_TEAM_SOCKET", "VIVE_TEAM_TOKEN"]`,
      ''
    ].join('\n');

    await fs.writeFile(codexConfigPath, content + section, 'utf-8');
  }

  async function cleanupCodexMcp(): Promise<void> {
    const codexConfigPath = join(homedir(), '.codex', 'config.toml');
    try {
      let content = await fs.readFile(codexConfigPath, 'utf-8');
      content = removeTomlSection(content, CODEX_SECTION);
      await fs.writeFile(codexConfigPath, content.trim() + '\n', 'utf-8');
    } catch {
      /* noop */
    }
  }

  // ---- IPC ハンドラ ----

  ipcMain.handle(
    'app:setupTeamMcp',
    async (
      _e,
      projectRoot: string,
      teamId: string,
      teamName: string,
      _members: { agentId: string; role: string; agent: string }[]
    ) => {
      try {
        if (!teamHub.isRunning) {
          return { ok: false, error: 'TeamHub is not running' };
        }

        teamHub.registerTeam(teamId, teamName);

        const [claudeChanged] = await Promise.all([
          setupClaudeMcp(),
          setupCodexMcp()
        ]);

        // ダイアログは出さずに renderer へ「変更あり」を返すだけ。
        // renderer 側が必要に応じて既存 Claude タブを自動再起動する。
        return {
          ok: true,
          socket: teamHub.socketAddress,
          changed: claudeChanged
        };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }
  );

  ipcMain.handle('app:cleanupTeamMcp', async (_e, _projectRoot: string, teamId: string) => {
    try {
      if (teamId && teamId !== '_init') {
        teamHub.clearTeam(teamId);
      }
      await Promise.all([cleanupClaudeMcp(), cleanupCodexMcp()]);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // 後方互換: レンダラーが旧 API を呼んでもエラーにしないためのスタブ
  ipcMain.handle('app:getTeamFilePath', (_e, teamId: string) => {
    return join(homedir(), '.vibe-editor', 'teams', `${teamId}.json`);
  });

  ipcMain.handle('app:getMcpServerPath', () => {
    // 後方互換: 新方式では bridge パスを返す
    return teamHub.bridgePath;
  });

  ipcMain.handle('app:getTeamHubInfo', () => {
    return {
      socket: teamHub.socketAddress,
      token: teamHub.token,
      bridgePath: teamHub.bridgePath
    };
  });
}

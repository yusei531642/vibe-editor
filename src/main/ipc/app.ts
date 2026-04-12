import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { promisify } from 'util';
import type { ClaudeCheckResult } from '../../types/shared';

const execFileAsync = promisify(execFile);

/**
 * 指定コマンド（例: `claude`）が PATH 上に存在するか確認する。
 * - 絶対パス / 相対パス（区切り文字を含む）が渡された場合は fs.access で検証
 * - それ以外は `where` (Windows) / `which` (Unix) でパス解決
 */
async function checkClaudeAvailable(command: string): Promise<ClaudeCheckResult> {
  const cmd = command.trim() || 'claude';

  // パス区切りを含む → ファイル直接チェック
  if (/[\\/]/.test(cmd)) {
    try {
      await fs.access(cmd);
      return { ok: true, path: cmd };
    } catch {
      return { ok: false, error: `ファイルが見つかりません: ${cmd}` };
    }
  }

  // PATH 上で探す
  const resolver = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileAsync(resolver, [cmd], { windowsHide: true });
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

  // ---------- Team MCP ----------

  /** MCP サーバーのスクリプトパス（バンドル後は app.asar 内） */
  function getMcpServerPath(): string {
    // dev: src/mcp/team-server.js, prod: resources/mcp/team-server.js
    if (app.isPackaged) {
      return join(process.resourcesPath, 'mcp', 'team-server.js');
    }
    return join(__dirname, '..', '..', 'src', 'mcp', 'team-server.js');
  }

  /** チーム共有ステートファイルのパス */
  function getTeamFilePath(teamId: string): string {
    return join(homedir(), '.vibe-editor', 'teams', `${teamId}.json`);
  }

  // ---- Claude Code: ~/.claude.json (ユーザーレベル MCP 設定) ----

  /** @returns true if config was actually changed */
  async function setupClaudeMcp(serverPath: string): Promise<boolean> {
    const claudeConfigPath = join(homedir(), '.claude.json');
    let config: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(claudeConfigPath, 'utf-8');
      config = JSON.parse(raw);
    } catch {
      // ファイルが無ければ新規作成
    }
    if (!config.mcpServers) {
      config.mcpServers = {};
    }
    const servers = config.mcpServers as Record<string, unknown>;
    const desired = { command: 'node', args: [serverPath] };

    // 既に同じ設定なら書き込み不要
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

  // ---- Codex: ~/.codex/config.toml (TOML) ----

  const CODEX_SECTION = 'mcp_servers.vive-team';

  /** TOML から指定セクション（及びそのサブセクション）を除去 */
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
    // 末尾の余分な空行を整理
    while (result.length > 0 && result[result.length - 1].trim() === '') result.pop();
    return result.join('\n');
  }

  async function setupCodexMcp(serverPath: string): Promise<void> {
    const codexDir = join(homedir(), '.codex');
    const codexConfigPath = join(codexDir, 'config.toml');
    await fs.mkdir(codexDir, { recursive: true });

    let content = '';
    try {
      content = await fs.readFile(codexConfigPath, 'utf-8');
    } catch {
      // ファイルが無ければ新規作成
    }

    // 既存の vive-team セクションを除去
    content = removeTomlSection(content, CODEX_SECTION);

    // セクションを追記（env_vars でチーム用環境変数を明示的に転送）
    const escaped = serverPath.replace(/\\/g, '/');
    const section = [
      '',
      `[${CODEX_SECTION}]`,
      `command = "node"`,
      `args = ["${escaped}"]`,
      `env_vars = ["VIVE_TEAM_ID", "VIVE_TEAM_ROLE", "VIVE_AGENT_ID", "VIVE_TEAM_FILE"]`,
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
      members: { agentId: string; role: string; agent: string }[]
    ) => {
      try {
        // 1. 共有ステートファイルを初期化（_init 以外の場合のみ）
        let teamFile = '';
        if (teamId !== '_init') {
          teamFile = getTeamFilePath(teamId);
          const teamDir = join(homedir(), '.vibe-editor', 'teams');
          await fs.mkdir(teamDir, { recursive: true });

          const state = {
            team: { id: teamId, name: teamName },
            members: members.map((m) => ({
              agentId: m.agentId,
              role: m.role,
              agent: m.agent,
              status: 'starting',
              joinedAt: new Date().toISOString()
            })),
            messages: [],
            tasks: []
          };
          await fs.writeFile(teamFile, JSON.stringify(state, null, 2), 'utf-8');
        }

        // 2. Claude Code (~/.claude.json) と Codex (~/.codex/config.toml) の両方に登録
        const serverPath = getMcpServerPath().replace(/\\/g, '/');
        const [claudeChanged] = await Promise.all([
          setupClaudeMcp(serverPath),
          setupCodexMcp(serverPath)
        ]);

        // 設定が実際に変更された場合のみダイアログ表示
        if (claudeChanged) {
          const win = BrowserWindow.getAllWindows()[0];
          if (win) {
            dialog.showMessageBox(win, {
              type: 'info',
              title: 'MCP 設定更新',
              message: 'Claude Code の MCP サーバー (vive-team) を登録しました。',
              detail: '変更を反映するには、実行中の Claude Code を再起動してください。',
              buttons: ['OK']
            });
          }
        }

        return { ok: true, teamFile };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }
  );

  ipcMain.handle('app:cleanupTeamMcp', async (_e, projectRoot: string, teamId: string) => {
    try {
      // 共有ステートファイルを削除
      const teamFile = getTeamFilePath(teamId);
      try {
        await fs.unlink(teamFile);
      } catch {
        /* noop */
      }

      // Claude Code / Codex 両方からクリーンアップ
      await Promise.all([
        cleanupClaudeMcp(),
        cleanupCodexMcp()
      ]);

      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('app:getTeamFilePath', (_e, teamId: string) => {
    return getTeamFilePath(teamId);
  });

  ipcMain.handle('app:getMcpServerPath', () => {
    return getMcpServerPath();
  });
}
